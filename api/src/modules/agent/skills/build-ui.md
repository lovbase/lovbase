---
name: build-ui
description: How the generated app is built — stack, hard rules, design rules and code style. Load before creating or changing any page, component, layout or style. Required for any UI work done directly with the file tools.
---
# Building the app's interface

The app is a Vite + React 19 + TypeScript frontend on Tailwind CSS v4 and shadcn/ui (Base UI build). Components live in `src/components/ui/`: button, card, input, table, badge, dialog, select, tabs, textarea, label, separator, dropdown-menu, sheet, skeleton, checkbox, switch, tooltip, empty. Icons from `lucide-react`; the `cn()` helper is in `src/lib/utils.ts`. Routing is `react-router` (`<Routes>/<Route>`, `NavLink`, `useParams`).

Data only ever through `sql()` and `schema()` in `src/lib/lovbase.ts`; the `IR / Entity / Field` types are there too.

## How to work

1. `list_app_files`, then `read_app_file` the files you will touch. Never write a file you have not read this turn.
2. Prefer `edit_app_file` (find/replace one exact passage) for changes inside an existing file; `write_app_file` for a new file or a rewrite. Keep each edit to one intention.
3. After the edits, `run_app_command` with `bun run typecheck`. Fix what it reports before you say you are done. The preview hot-reloads; you do not need to build to see it.
4. Say what you changed, in one or two sentences, naming the files.

## Hard rules

- No backend, no direct database access, no ORM, no state library. All data access goes through `sql()` with `$1, $2` parameters.
- Check the schema first (`get_schema`): `dbName` is what SQL uses, `name` is the display label; a `link` field holds the target's uuid; a `select` field's allowed values are in `options`.
- A new field or table is a `propose_schema` call, never an edit to the app.
- Keep `bun run dev` starting and `bun run build` passing. Do not change host/port in `vite.config.ts`, do not edit `src/lib/lovbase.ts` or `src/lib/analytics.ts`, do not remove `startAnalytics()` from `main.tsx`.
- When `schema()` reports `readOnly`, render no create, edit or delete affordances at all.
- `src/App.tsx` is the shell (sidebar + routes); pages live in `src/pages/`. Every entity starts with a generic `TablePage`; replace it with the real screen the request calls for.

## Design rules

- shadcn's semantic colours only: `bg-background / text-foreground / text-muted-foreground / border / bg-card / bg-primary`. No hex colours, no inline styles.
- Page shape: a title row (`text-2xl font-semibold tracking-tight` plus one line of `text-muted-foreground`) followed by content cards. Spacing `p-6 md:p-8`, `space-y-6`, `gap-4`.
- Lists use `Table`, status uses `Badge`, actions use `Button` (`size="sm"`, icons `size-4`), forms go in a `Dialog` or `Sheet`, numbers get `tabular-nums`.
- Metric cards: `CardHeader` for the label (`text-sm font-medium text-muted-foreground`), `CardContent` for the number (`text-2xl font-semibold`).
- Empty states use the `Empty` component or one centred `text-muted-foreground` line; loading uses `Skeleton`.
- Write the interface copy in the language the user wrote in. Keep it restrained — do not pile on features nobody asked for.

## Code style

Ordinary readable code: one statement per line, a blank line between components, wrap past 110 characters, one JSX prop per line when there are many. `run_app_command` with `bun run format` at the end settles the rest.
