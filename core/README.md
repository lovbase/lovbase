# @lovbase/core

**MIT.** The engine behind [Lovbase](../README.md), packaged on its own because the problem it
solves is not specific to Lovbase.

## The problem

You let a model change a database schema from a sentence. The user says *"rename 名称 to 公司全称"*.
The model returns a new schema. You diff it against the old one by name — and the column is gone
and a new one has appeared, so you drop and recreate. Every row of that column is now empty.

The fix is not a better prompt. It is to stop diffing by name.

## The shape of the answer

```
natural language → IR with stable ids → deterministic diff → whitelisted DDL
```

- **`ir.ts`** — the schema as data: entities and fields, each carrying an `id` that never changes.
  Names are labels. `validateIR` rejects what the model got structurally wrong before anything else
  sees it.
- **`diff.ts`** — `diffIR(prev, next)` compares **by id**, so a field whose `dbName` changed while
  its id survived is a `rename_field`, not a drop plus an add. `isDestructive` marks the three
  changes that can lose data, which is what lets a caller route them to a human.
  `irEquals` is the complement: it sees the things the differ deliberately ignores (labels, select
  options, `required`), because an empty diff is not the same as an unchanged model.
- **`ddl.ts`** — every `Change` maps to hand-written SQL. Model output never reaches this layer as
  SQL, only as validated `Change` objects, so the blast radius of a bad generation is bounded by
  what this file is willing to emit.

The payoff is that correctness stops being a matter of opinion. "Did it rename the column or
recreate it" is `rename_field` versus `drop_field` + `add_field` — which is why the
[eval suite](../api/evals/README.md) can assert exactly instead of asking another model to judge.

## Use

```ts
import { IR, assignIds, validateIR } from '@lovbase/core/ir'
import { diffIR, isDestructive } from '@lovbase/core/diff'
import { changeToSQL } from '@lovbase/core/ddl'

const next = assignIds(IR.parse(fromTheModel))   // new entities/fields get ids here
const errors = validateIR(next)
if (errors.length) throw new Error(errors.join('; '))

const changes = diffIR(current, next)
if (changes.some(isDestructive)) return askTheHuman(changes)

for (const c of changes) for (const sql of changeToSQL(c, next, 'my_schema')) await db.query(sql)
```

Only dependency is `zod`.

## Two notes on scope

`plans.ts` and `templates.ts` also live here, and they are **not** part of the engine — they are
product data (pricing tiers, starter templates) that both the backend and the UI need, and this is
the package both already depend on. The library described above is `ir` / `diff` / `ddl`.

The package is not on npm. Its `exports` point at `.ts` source, which suits the bundlers in this
repo but not a plain Node consumer; publishing would mean adding a build step first. Until then:
MIT, vendor it.
