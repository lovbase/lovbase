# Source-tool efficiency evaluation

Run from the repository root with the same configured provider/model for both variants:

```sh
bun --env-file=app/.env api/evals/file-efficiency.ts /tmp/file-efficiency.json
```

This makes paid provider requests but does not touch application source, wallets or billing ledgers. Each variant starts with an isolated temporary copy of the same TypeScript files. It uses real production file tools and deterministic functional assertions, plus TypeScript checking. The baseline exposes the former whole-file read and single-passage edit tools; the optimized variant uses bounded reads, batched edits with validation, and historical payload compaction. The fixture's unrelated comments model a larger file; this is a small synthetic benchmark, not a replay of a production application. The evaluation prompt isolates source editing rather than reproducing the entire platform system prompt/tool catalogue.

`EVAL_MODE=optimized` runs only the changed variant. `EVAL_MODEL_RATE` may contain a verified `ModelRate` JSON value and `EVAL_MARGIN` its multiplier to calculate per-request credits. Without a verified rate, calculated credits are deliberately null. Token counts and cache counts come from the provider; missing usage is reported rather than estimated. No provider prices are inferred from a model name.

## Measured on 2026-10-28

Model: locally configured `gpt-5.6-sol`, same endpoint and initial files. Baseline measured first; optimized rerun after combining batch edits and validation. All six compared runs passed functional assertions and TypeScript checks; no request lacked usage data. This is one sample per variant/scenario, so savings are not a statistical guarantee.

| Scenario | Requests, before → after | Input tokens, before → after | Input reduction | Output tokens, before → after | Cached input, before → after | Uncached input, before → after |
| --- | --- | --- | --- | --- | --- | --- |
| Style and links | 5 → 3 | 10,792 → 5,673 | 47.4% | 204 → 205 | 3,328 → 2,176 | 7,464 → 3,497 |
| Cross-file behavior | 5 → 3 | 19,742 → 8,400 | 57.4% | 346 → 306 | 12,416 → 3,456 | 7,326 → 4,944 |
| Continue a long conversation | 5 → 3 | 40,247 → 6,117 | 84.8% | 229 → 200 | 30,464 → 0 | 9,783 → 6,117 |

Requests fell 40% in every scenario. Fewer cached tokens do not alone imply higher cost: absolute uncached input also declined in all three. Real charged credits still depend on the provider price, configured cached-input price, per-request rounding and output tokens; verify those against production invoices before promising an equivalent credit reduction.

The available local settings had no custom `billing.rates` or platform model record and used an environment-configured model. They do not establish the live `gpt-6-astra` rate shown in the user's screenshot. No prices or balances were changed.

Regression verification: 410 tests passed, 54 environment-dependent integration tests skipped, zero failures. API build, API/application typechecks and application production build passed. A local production-server smoke check returned HTML for `/`, redirected anonymous `/admin` to `/login`, and rejected a direct anonymous call to the administrator server function with 403. Authenticated visual review was not performed.

## Integration and rollout

- Existing file tools remain available; new tools are `search_app_files`, `read_app_files`, and `edit_app_files`. Read continuations carry line and column so long lines can be resumed without loss. The final edit batch can request `typecheck` or `format-and-typecheck` in the same call.
- Deploy the sandbox endpoint before the API using it. Both the Worker and Docker runner share `/apps/:id/search-source`; the runner image/runtime needs the updated code. No new sandbox dependencies are needed.
- Normal schema initialization adds nullable request pricing snapshots and a nullable parent chat-run link for coding runs. Existing rows and credits are unchanged; historical child runs without a parent cannot be retroactively attributed.
- Completed chat metadata now contains request count, input/output/cached tokens, model and container credits/cost, missing-usage count and the run ID. The chat cost tooltip shows the breakdown. Administrator diagnostics identify configured models using fallback or unspecified cache pricing; snapshots in `lb_model_requests.pricing` preserve future request pricing for audits.
- Model context compaction is deterministic and restricted to successful file operations and command logs in completed prior turns. It preserves original stored messages, current work, errors, tool-call/result IDs and approval-bearing operations. Current code is reread when needed. No extra summarizer model is called.
