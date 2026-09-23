---
name: lovbase
description: Read the Lovbase workspace schema and query its data from the sandbox; propose schema changes; know which UI components are installed.
---

# Lovbase data access

Commands available in this sandbox (already on PATH, env already set):

- `lovbase schema` — prints `{ ir, ddl, schema }`. `ir.entities[].fields[]` has `dbName` (use in SQL), `name` (label), `type`, `options`, `linkTo`.
- `lovbase sql "select * from customers limit 5"` — runs one statement as the workspace role. Only SELECT/INSERT/UPDATE/DELETE. Params: `lovbase sql "select * from orders where status = \$1" '["paid"]'`.
- `lovbase propose "add an email field to the customers table"` — asks Lovbase to evolve the schema. Additive changes apply immediately; deletions wait for the owner to confirm in Lovbase.

Steps when building a page:
1. `lovbase schema` to learn tables and field names.
2. `lovbase sql` a couple of times to see real data shapes before writing UI.
3. In code, use `sql()` / `schema()` from `@/lib/lovbase` — same API, same permissions.
4. Build with the installed shadcn/ui components (`@/components/ui/*`), Tailwind semantic colors, lucide icons; follow AGENTS.md design rules.
5. Run `bun run build` before finishing; fix type errors.
