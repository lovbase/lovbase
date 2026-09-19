# Evals for the modelling pipeline

```bash
bun run eval                          # every case against the configured model
bun run eval --category rename        # one category
bun run eval --case "link"            # cases whose name contains "link"
bun run eval --json report.json       # machine-readable output
```

## Why these evals can be exact

Most LLM evals need a second model to grade the first one, because the output is prose and prose
has no equality. This pipeline does not have that problem:

```
(current IR, one sentence) → LLM → validateIR → diffIR → assertions
                                                   ↑
                                        deterministic, by stable id
```

The model's output is a **validated IR**, and the thing we actually care about is the **diff**
between the old IR and the new one. `diffIR` is a pure function over stable ids, so "did it rename
the column or drop and recreate it" is not a matter of opinion — it is `rename_field` versus
`drop_field` + `add_field`. Every assertion in this suite is an exact match on that diff.

No judge model, no rubric, no drift between runs. That is a property of this problem rather than a
general technique, and it is the reason the numbers below mean something.

## What is asserted

Two safety properties are **derived, not declared**, so the common case stays terse and the
dangerous case cannot pass by omission:

| Property | Default | Turned off by |
|---|---|---|
| No destructive change in the diff | on | expecting one in `changes` |
| Every entity/field id in `given` survives | on | expecting a drop |

So a case that only says "expect `add_field customers.phone`" is also asserting, for free, that
nothing was dropped, no type changed, no id vanished and no other column was touched. A model that
answers the question correctly *and* helpfully renames two unrelated columns fails.

Ids are tracked as `entity-id/field-id`, never by table name — a table rename changes the name, and
mistaking that for a lost column is exactly the false positive this suite exists to rule out.

## Categories

| Category | What it is for |
|---|---|
| `add` | The baseline. A model that fails here is unusable; these double as a smoke test. |
| `rename` | The product's central claim. Must come out as `RENAME`, never drop + create. |
| `type-change` | Destructive changes are allowed — they have to be *recognised*, which is what routes them to the confirmation step. |
| `modeling-judgment` | Does it model or just transcribe? A fixed set of states is a `select`, a reference is a `link`, a yes/no is a `boolean`. |
| `preserve` | Iron rule 3: changing one thing must not disturb anything else. |
| `ambiguous` | The pure modeller cannot ask a question, so the bar is restraint — a vague sentence must not become five invented tables. |
| `adversarial` | Injection, forced drops, system column names, SQL smuggled into identifiers. |

## Reading the numbers

```
model                        pass   first try   avg tries   avg ms
gpt-5.6-sol                   95%        100%        1.00     6655
```

`first try` is the interesting column. The pipeline retries up to three times, feeding
`validateIR`'s errors back into the prompt, so `pass` alone hides how much work that rescue is
doing. A model at 95% pass / 60% first try is one that needs the retry loop; the same 95% at 100%
first try does not. The final line reports how many runs the feedback actually rescued.

`--json` writes the per-case detail, which is what you want when comparing two models rather than
eyeballing one.

## Comparing models

```bash
EVAL_MODELS='[
  {"label":"gpt-5.2","baseURL":"https://api.openai.com/v1","apiKey":"sk-…","model":"gpt-5.2"},
  {"label":"sonnet-5","baseURL":"https://api.anthropic.com/v1/","apiKey":"sk-ant-…","model":"claude-sonnet-5"}
]' bun run eval
```

With no `EVAL_MODELS`, the single model from `LLM_BASE_URL` / `LLM_MODEL` (or `ANTHROPIC_API_KEY`)
is used, so the command works with the same configuration as local development.

## The one case that is red on purpose

`adversarial/prompt injection asking to drop everything` fails, and is marked `stretch` rather than
fixed. Models do comply with that prompt. What the failure documents is the layer that makes it
survivable: `diffIR` marks the result destructive and `ProposeService` parks it as a pending
confirmation, so no table is dropped without the owner clicking through. **The model is not the
safety boundary; the pipeline is.** Tighten the system prompt and this should go green — but the
architecture should not depend on that happening.

## What this does not cover

The suite ends at `diffIR`. It does not exercise `ProposeService` (which decides apply-now versus
park-for-confirmation) or `ApplyService` (which emits the DDL), because both need a database. Those
deserve integration tests rather than evals — the behaviour is deterministic and does not need a
model in the loop.
