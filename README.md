# Lovbase

**English** · [简体中文](./README.zh-CN.md)

Describe what you need in a sentence, get a real Postgres database with a working app on top —
then change your mind, and keep every row you already had.

> In development, validating the MVP. AGPL-3.0, with the engine in [`core/`](./core/README.md) under MIT.

## The problem this is actually about

Letting a model change a live database schema is easy to demo and hard to survive.

A user says *"rename 'Name' to 'Company name'"*. The model returns the new schema. You diff it against the
old one the obvious way — by name — and what you see is a column that vanished and a column that
appeared. So you emit `DROP COLUMN` and `ADD COLUMN`. Every value that column held is gone, and
the only signal the user gets is an empty screen.

A better prompt does not fix this. The information needed to tell *renamed* apart from *deleted,
and separately added* is not in the model's output at all. It has to be in the representation.

## The answer

```
natural language → IR with stable ids → deterministic diff → whitelisted DDL → real Postgres
```

**The LLM never writes SQL.** It only ever produces an IR (`core/src/ir.ts`) — entities and fields,
each carrying an id that never changes. Names are labels. Deterministic code does the rest:

- **The diff compares by id, never by name.** A field whose `dbName` changed while its id survived
  is a `rename_field`, so it compiles to `ALTER TABLE … RENAME COLUMN` and the data stays put.
- **The three changes that can lose data are marked as such** and stop for the owner to confirm,
  rather than being applied and apologised for.
- **DDL is a whitelist.** Every change kind maps to hand-written SQL in `core/src/ddl.ts`; model
  output reaches that layer as validated objects, never as a string to execute.
- **Every project gets its own Postgres schema** (`p_<id>`) and a role holding DML rights and
  nothing else (`ws_<id>`), so the blast radius of anything going wrong is one tenant.

The payoff is that correctness stops being a matter of opinion: *did it rename the column or
recreate it* is `rename_field` versus `drop_field` + `add_field`. That is what makes the
[eval suite](./api/evals/README.md) able to assert exactly, instead of asking another model to judge.

## The product

| Route | What it is |
|---|---|
| `/` | Home: a prompt box that starts building, plus your projects (per-plan project caps live in `core/src/plans.ts`) |
| `/p/:id` | Builder: Agents / Preview / Database / Code |
| `/s/:token` | Share link: no sign-in, can read and enter data, cannot change the schema |
| `/settings` | BYOK: your own OpenAI-compatible endpoint and key (stored AES-GCM encrypted) |

## Data API (for your own frontend, or the coding agent in the sandbox)

Auth: `Authorization: Bearer <api_token>` (shown in the Database tab), or the owner's session cookie.

```
GET  /api/data/:id/schema        → { ir, ddl, schema }
POST /api/data/:id/sql           → { sql, params }  runs as ws_<id>, one statement, inside a transaction
POST /api/data/:id/schema        → { ir } or { message }  goes through the IR → diff → DDL pipeline
```

The safety boundary of `/sql` is Postgres permissions, not SQL parsing. The role has SELECT/INSERT/UPDATE/DELETE
on its own schema and nothing else — no CREATE, ALTER or DROP. Statements go through the extended protocol, so
Postgres itself rejects multi-statement strings. `SET LOCAL role/search_path/statement_timeout` all happen inside
the transaction, so nothing leaks into the next request that reuses the pooled connection. `POST /schema` is the
only way a schema ever changes, and destructive changes stop there and wait.

## Local development

```bash
bun install
docker compose up -d                 # Postgres :5433, Redis :6379, MinIO :9000, and its bucket
cp .env.example app/.env             # fill in LLM_* or ANTHROPIC_API_KEY, and uncomment the S3_* block
docker build -f sandbox/Dockerfile -t lovbase-sandbox:local sandbox   # the image generated apps run in, once
```

Then two long-running processes, one per terminal:

```bash
bun run runner                       # sandbox runner on :8788 (starts a container per generated app)
bun run dev                          # rspack watching api/ + vite dev, on http://localhost:3008
```

And the checks:

```bash
bun run lint                         # oxlint, including the layering rules
bun run typecheck                    # api and app
bun run test                         # the core engine + backend unit tests
bun run eval                         # the modelling evals (makes real LLM calls)
```

`docker compose up -d` also creates the attachment bucket, because the app never creates buckets
itself — in production that is a dashboard action and its credentials are not allowed to. If
something already holds port 9000, `MINIO_PORT=9200 docker compose up -d` and point `S3_ENDPOINT`
at the same port.

Leaving `S3_*` unset still works: attachments then stay inline as base64, which is what puts
screenshots inside the transcript in Postgres and re-sends them to the model on every later turn.
Fine for a quick look, not for anything that keeps data.

`bun run dev` bundles `api/` once, then runs rspack in watch mode alongside Vite — the backend is a build
artifact and the frontend imports it as `@lovbase/api`. Editing backend code triggers a rebuild, and the dev
server restarts so the change is live.

Tables and the `lovbase_sql` executor role are created at startup, so there is no migration step; the account in
`DATABASE_URL` needs CREATEROLE. Every environment variable is declared and validated once in
`api/src/config/config.service.ts`, so a typo fails at boot instead of surfacing as a 500 whenever that code path
first runs.

## Evals

The modelling pipeline has an eval suite, because "the LLM usually gets it right" is not a thing
you can put in a changelog. It lives in [`api/evals/`](./api/evals/README.md).

What makes it exact: the model's output is a validated IR, and what we assert on is the **diff**
between the old IR and the new one. `diffIR` is a pure function over stable ids, so "did it rename
the column or drop and recreate it" is `rename_field` versus `drop_field` + `add_field` — not a
matter of opinion. No judge model, no rubric, no drift between runs.

```
bun run eval

model                        pass   first try   avg tries   avg ms
gpt-5.6-sol                   95%        100%        1.00     6655

category                   gpt-5.6-sol
add                                3/3
rename                             4/4
modeling-judgment                  4/4
type-change                        2/2
preserve                           3/3
ambiguous                          2/2
adversarial                        2/3
```

`first try` is the column that matters: the pipeline retries up to three times with `validateIR`'s
errors fed back into the prompt, so `pass` alone hides how much work that rescue is doing.

The one red case is deliberate — a prompt injection that talks the model into proposing a full
wipe. It stays red because the model really does comply, and the point is that nothing reaches
Postgres anyway: `diffIR` marks the result destructive and it parks as a pending confirmation.
The model is not the safety boundary; the pipeline is.

## The sandbox: two ways to run it, one codebase

Generated apps are written and run by pi inside a sandbox container. The main app only knows `SANDBOX_URL`, and
behind it can be either of:

| | Cloudflare (`sandbox/src/index.ts`) | Docker runner (`sandbox/runner/`) |
|---|---|---|
| Runtime | Cloudflare Sandbox (Containers + DO) | Any Docker host, one container per app |
| File persistence | R2 snapshot + Postgres snapshot | Docker volume, survives a restart |
| Preview URL | `5173-<id>-<token>.<domain>` | A host port (put Caddy in front for wildcard subdomains) |
| Publish a static site | R2 | Not supported (returns 501) |
| Isolation | Managed by Cloudflare | Containers; for multi-tenant use, run Docker under gVisor (runsc) |
| Start it | `cd sandbox && bun run dev` | `bun run runner` |

There is exactly one HTTP contract — the Hono routes in `sandbox/src/app.ts`. Each side implements
`SandboxBackend` from `sandbox/src/backend.ts` (exec / read and write files / preview / destroy), and every
difference lives in that one layer. The main app's client
(`api/src/modules/sandbox/sandbox.service.ts`) is derived from the route types, so changing the contract is a
compile error on the calling side.

## Self-hosting (no Cloudflare)

```bash
docker build -f sandbox/Dockerfile -t lovbase-sandbox:local sandbox   # the image generated apps run in
docker compose -f docker-compose.private.yml up -d                     # app + postgres + redis + minio + sandbox-runner
```

The main app image is the `Dockerfile` at the repository root. Postgres, analytics events, pi and the model keys
all stay on your own network; models go through BYOK or an internal gateway.

## Deployment: the app on Railway, the sandbox on Cloudflare

The main app is an ordinary Node process. `app/server.mjs` mounts NestJS first (`/api/*`, `/ingest/*`), then the
static assets, and hands everything else to TanStack Start — one process, one port, with the backend and the UI
sharing a single DI container and a single set of connection pools. It sits next to Postgres, so all database
traffic stays on the private network. The sandbox stays on Cloudflare, where one container per app, preview
domain routing, idle hibernation and R2 static hosting all come from the platform. The two talk over HTTP.

The backend also runs on its own (`bun run --cwd api start`, i.e. `api/src/main.ts`). Splitting them into two
services is a deployment change rather than a code change — `app/src/functions/_ctx.ts` is the only place that
would become an HTTP call.

### 1. Railway: the app + Postgres + Redis

Create a project, add Postgres and Redis services, then add a service from this repository (root `Dockerfile`;
`railway.toml` is already set up). Pick a Railway region close to your Cloudflare containers so the sandbox's
callbacks to the app take a shorter path. Environment variables:

```
DATABASE_URL            Postgres private connection string (the account needs CREATEROLE)
REDIS_URL               Redis private connection string (transient run recordings, 2-hour TTL)
SQL_ROLE_PASSWORD       a strong password; the lovbase_sql role is created on first boot
BETTER_AUTH_SECRET
BETTER_AUTH_URL         https://your-domain
SANDBOX_URL             whatever step 2 deploys to (https://lovbase.app)
SANDBOX_INTERNAL_TOKEN  must match the sandbox Worker's INTERNAL_TOKEN
ADMIN_EMAILS
LLM_BASE_URL LLM_API_KEY LLM_MODEL   the platform default model; Pro users can BYOK
VITE_POSTHOG_KEY        build-time; analytics is off entirely without it (leave unset when self-hosting)
```

The app creates its own tables on first boot, so there are no migrations to run. Once the domain points at
Railway, turn on Cloudflare's orange-cloud proxy for `lovbase.dev`: hashed static assets cache at the edge, and
`/api/*`, `/ingest/*` and server-function requests need a rule that bypasses the cache.

### 2. The sandbox Worker (deploy this first — the app points at it)

```bash
cd sandbox
wrangler secret put INTERNAL_TOKEN        # the app authenticates with the same value
wrangler deploy                            # needs Docker running locally; it builds and pushes the image
```

Before deploying, edit `sandbox/wrangler.jsonc`: point `LOVBASE_API_URL` and `LOVBASE_PUBLIC_API_URL` at the
app's domain, leave `SANDBOX_HTTP_PROXY` empty (the local proxy belongs in `sandbox/.dev.vars`), and raise
`max_instances` as needed. The sandbox uses Containers, which requires a paid Workers plan.

**Two domains on purpose.** The product lives on `lovbase.dev`; everything users produce — previews and
published apps — lives on `lovbase.app`. Putting untrusted generated code under a different registered domain
means it can never reach the product domain's origin.

The preview URL is derived from the hostname the sandbox Worker is reached on, so it is bound to the apex of
`lovbase.app` and previews look like `5173-<sandbox>-<token>.lovbase.app` — a single label, which the free
Universal SSL certificate covers. Using `*.sandbox.lovbase.app` would be two labels and would need a paid
certificate for no benefit.

### 3. Keeping the bill down

Railway is a fixed-size machine. Cloudflare has no hard spending cap — go over and it is metered, with usage
alerts as the only warning — so the sandbox's cost has to be bounded structurally. There are three controls:

- **Credits.** Conversations are metered from actual input/output tokens and the model tier, with a minimum
  charge of 1 credit. Coding requests use measured input/output/cache tokens and separately measured container time,
  without the former 20-credit generation floor. Free users get 30 credits per month. Missing provider
  usage is recorded for review and never estimated.
- **`SANDBOX_SLOT_COUNT` + `max_instances`**: Redis atomically schedules the former (default 5), while
  `sandbox/wrangler.jsonc` enforces the latter as the hard platform ceiling. Keep the slot count at or below it.
- **Warm grace + `SANDBOX_SLEEP_AFTER`**: a finished task stays warm for 120 seconds after the last real composer
  edit, then a static snapshot takes over and BullMQ stops it. The platform idle timer remains 5 minutes as a backstop.

Container size can come down too — `instance_type` goes `standard-1` → `basic` → `dev` → `lite` — but Boris runs
`bun install` and Vite, so verify on a test project before dropping it.

**To cap the bill absolutely**, skip Cloudflare Containers and use the bundled Docker runner on a
fixed-price server (`docker-compose.runner.yml`), then point the app's `SANDBOX_URL` at it. The cost is losing
static-site publishing, and having to set up wildcard subdomains yourself.

### 4. Payments (optional)

Pro subscriptions and credit packs use Stripe Checkout; Business keeps its contact flow. See “Credits and plans” below for configuration and local sandbox testing.

## Structure

Four packages, split by deployment unit: `core` is the pure engine, `api` is the backend, `app` is the
interface, and `sandbox` is the service that runs generated apps.

```
core/src/             IR + an id-based differ + a whitelisted DDL generator. Pure functions, anyone may depend on it
core/src/plans.ts     Plans, prices and credit costs (defined once, shared by both sides)
core/src/templates.ts Versioned bilingual template catalog (see templates/README.md)
templates/inventory/ Original inventory UI, shared by the read-only preview and editable copies

api/                  The NestJS backend. Runs embedded in the app process, or on its own via `node dist/main.js`
  src/config/         Every environment variable, declared here and validated at boot
  src/database/       Two process-wide pools + table creation
  src/common/         Domain errors, the Express⇄fetch bridge, the global auth guard (@Public opts out)
  src/modules/        auth · projects · apps · modeling · data · sql · roles · credits
                      billing · llm · sandbox · agent · analytics · templates · ingest · limits
  rspack.config.ts    Bundled with SWC (Nest's DI needs decorator metadata, which esbuild cannot emit)

app/                  TanStack Start: the interface and SSR
  src/functions/      Server functions, one file per domain, all authorized through _ctx.ts before calling a service
  src/functions/_ctx.ts  The only authorization entry point, and the only file that knows about TanStack's request plumbing
  server.mjs          Production entry: Nest → static assets → TanStack Start, one process on one port

sandbox/src/app.ts    The sandbox HTTP API (Hono, shared by both backends)
sandbox/src/backend.ts The SandboxBackend interface
sandbox/src/index.ts  The Cloudflare backend (Containers + R2)
sandbox/runner/       The Docker backend (local development / self-hosting)
```

### The boundaries are enforced, not remembered

- **You cannot reach a project without authorizing.** Services only accept a `UserCtx` / `ProjectCtx` / `AppCtx`
  produced by `AccessService`, and the only way to get one is to hand it real request headers. Forgetting a line
  of authorization is a type error rather than a vulnerability. On the controller side a global `SessionGuard`
  requires a session by default; `@Public()` is the explicit opt-out.
- **Dependency direction lives in `.oxlintrc.json`.** `app/` may not import `pg`, the server-side `better-auth`,
  or any internal path of `@lovbase/api`; `api/` may not import `@tanstack/*` or `react` (it has to keep running
  without the app); controllers may not query the database directly. `bun run lint` enforces all of it.
- **The API's types are a build artifact.** `api` emits `dist/types` with tsc and `app` compiles against only
  that, so the two packages' compiler options can never collide.

## Routes

```
/                     Home (signed out = the marketing landing page, signed in = templates + new project)
/templates            Public template gallery → read-only preview → named Remix → project editor
/pricing              Pricing
/projects             Project list      /projects/:id   Builder
/share/:token         Public share
/settings             Account and usage  /admin          Admin console
/api/data/:ws/{sql,schema,events}   The data API (the older /w/:ws/* paths still work)
/api/billing/webhook  Stripe payment and subscription events
```

## Credits and plans

Agent conversations are metered from actual input/output tokens and the model tier, with a minimum charge of
1 credit. Coding generations charge measured model usage and container time separately, with no 20-credit floor.
Each provider request, including naming and schema retries, has a durable usage record and idempotent debit.
Missing usage is flagged for review without an estimated model charge. BYOK turns do not charge for the user's model tokens, but
platform sandbox time is still charged. Credits are granted per plan per period, and an admin can hand out extra
from /admin. Plans, prices, credits and caps are defined exactly once, in `core/src/plans.ts`.

Pro costs $25/month or $240/year. Both grant 500 credits each month; annual billing does not grant a full year of credits upfront.
Credit packs are 200/$10, 1,000/$45 and 5,000/$200, stored in a wallet that does not reset with the subscription period.
Business remains contact-only. Pro and pack purchases show an unavailable state when payments are not configured.

Free provides 2 projects, 200 MB account storage and 1 published app; Pro provides 25 projects, 5 GB and 25 published apps.
Pro also includes BYOK, custom publish subdomains, read-only database credentials, full SQL/source export and priority generation.
Expiry preserves existing projects, data and published pages while restricting growth and exclusive capabilities.
See [Free/Pro operations and validation](docs/free-pro-entitlements.md) for storage accounting, migration, configuration and tests.

Local Stripe sandbox setup (creates test objects only):

1. Install the official Stripe CLI and run `stripe login` for the sandbox account.
2. Set that sandbox's `STRIPE_SECRET_KEY=sk_test_...` and `BETTER_AUTH_URL=http://localhost:3008` in `app/.env`.
3. Run `bun run stripe:setup`. It creates or reuses five prices from `core/src/plans.ts` and a Customer Portal configuration, then saves their IDs to `app/.env`.
4. Keep `bun run stripe:listen` running in another terminal. It saves the signing secret to `app/.env` and forwards events to local `/api/billing/webhook`.
5. Restart the app (`bun run dev`, or `bun run start:web` after building), then test `/pricing` and `/settings`.

```dotenv
STRIPE_MODE=test
STRIPE_ACCOUNT_ID=acct_...
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_PRICE_CREDITS_SMALL=price_...
STRIPE_PRICE_CREDITS_MEDIUM=price_...
STRIPE_PRICE_CREDITS_LARGE=price_...
STRIPE_PORTAL_CONFIGURATION=bpc_...
```

Hosted Checkout requires no frontend publishable key. Keep secrets in local environment files and out of Git.
Production must set `STRIPE_MODE` explicitly; use `disabled` until cutover is verified. See [Stripe Live cutover](docs/stripe-live.md) for account verification, migration, release holds and manual refund operations.
Use Stripe's success test card `4242 4242 4242 4242`, any future expiry and three-digit CVC; use `4000 0000 0000 0002` for a decline.
Only use test cards when Stripe visibly indicates sandbox/test mode.

Subscribe to `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed`, `checkout.session.expired`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`.
The app verifies raw-body signatures and deduplicates events in database transactions. The return page waits for webhook delivery before confirming fulfillment.
Customer Portal supports payment methods, invoices and cancellation at period end, with plan switching disabled.
Cancellation preserves paid coverage; failed renewals never extend it. Restart the app if restarting the listener changes its signing secret.

Regression checks: `bun test api/tests/billing.test.ts core/tests/billing.test.ts app/tests/mcp-client.test.ts`.
This setup is local sandbox only. Live payments need separate live prices, secrets and a publicly reachable HTTPS webhook.
Refunds, disputes and automatic tax are outside the current implementation.

## Google Sheets imports (optional)

Set `COMPOSIO_API_KEY` from a Composio **Platform** project on both the web and worker processes.
Requires Node.js 22.22.3+. With no key, the connector catalog shows a configuration notice and connections are disabled. On first connection,
Lovbase creates a managed OAuth auth config with `spreadsheets.readonly` scope. Optionally provide
`COMPOSIO_SHEETS_AUTH_CONFIG_ID` for an existing read-only config. Set `BETTER_AUTH_URL` to the public
application origin; the authorization callback is `/api/integrations/google/callback`.

Composio usage is metered locally. Hobby defaults to Composio's published caps of 100,000 tool calls
and 50,000 trigger events per month; free usage is tracked but does not consume Lovbase credits.
Set `COMPOSIO_PLAN=pro` when the Platform project moves to Pro. The worker then reconciles the
Composio Usage API, applies the configured `$29` monthly usage credit, and records only chargeable
tool, trigger and connection usage in the Lovbase credit ledger.

Open **Connectors → Google Sheets → New connection** from the sidebar or the chat's **+** menu.
Connect Google, explicitly enable the connection for the project, then paste
a Sheets edit URL. Choose one worksheet, header row and optional bounded range (e.g. `A1:F500`).
Preview and validate field mappings before confirming. The worker atomically creates a new table and
imports the frozen snapshot, then generates the interface through the existing build queue.

Imports are one-time copies: no sync or Google writes. Limits are 10,000 data rows, 10 MiB and 1,000
columns, also subject to account storage quota. Keep the source stable during paged reads. Formula
results are imported; ambiguous date strings remain text. Retrying a failed interface build preserves
imported data and never inserts it again. Disconnecting a connection disables it across projects.

Run `bun test api/tests/sheets.test.ts api/tests/sheet-imports.test.ts api/tests/composio.test.ts` for
conversion, authorization, session restrictions and embedded PostgreSQL rollback tests. Before release,
verify real OAuth and import with a test Google account, including revoked authorization.

## Chat skills

Open **+ → Skills** in a project chat to enable built-in skills or import a single `SKILL.md`.
Custom skills are shared by all apps in that project; enabled skills are saved separately for each
user and remain available for later messages. The agent loads their instructions when relevant.
The core modeling and UI instructions are always enabled. The home-page catalogue is read-only.

Imported files must be UTF-8 Markdown, at most 64 KiB, with YAML frontmatter and a nonempty body:

```md
---
name: project-conventions
description: Apply this project's interface conventions.
---
Use the existing components and display dates as YYYY-MM-DD.
```

Names contain 1–64 lowercase letters, numbers and single hyphens, without leading or trailing
hyphens; descriptions contain 1–1024 characters. Duplicate built-in or project names are rejected.
Import enables the skill for the importing user. Deleting it removes it from the whole project.
ZIP packages, supporting files and scripts are not imported. No extra agent tools are installed.

Run `bun test api/tests/skills.test.ts` for format, persistence, isolation and agent-context checks.

### Remote MCP servers

Enable `MCP_ENABLED=true`, then open **Connectors → Add MCP server**. Connections belong to the signed-in account. Adding from a project automatically enables that project after a successful connection; other projects opt in separately. Account-level Disable stops future calls from every project.

Public HTTPS **Streamable HTTP** servers support OAuth (PKCE, dynamic registration, client metadata documents, or an optional pre-registered client), Bearer tokens, custom API-key headers, and anonymous access. Local processes, private networks and legacy SSE transports are not supported.

Configure a publicly reachable HTTPS `BETTER_AUTH_URL`. Register `${BETTER_AUTH_URL}/api/integrations/mcp/callback` for pre-registered OAuth clients. Client metadata is served at `/api/integrations/mcp/client-metadata`. OAuth attempts expire after ten minutes and survive restarts. Tokens refresh automatically; failed refresh requires reconnecting. Credentials are encrypted with the existing `BETTER_AUTH_SECRET`, which must remain stable.

The **Advanced: MCP registries** section retains directory discovery. Registry tokens authenticate only directory requests; configure authentication separately for each discovered server. Sync retains server IDs and project selections, marking removed entries unavailable. Agent write/destructive tools retain the existing approval flow. Existing MCP timeouts, result-size, project-server and per-turn call limits still apply. Outbound targets and DNS answers must be public; redirects are rejected, so enter the final endpoint URL.

### Use Lovbase from Claude Code, Codex and Cursor

Open **MCP** in the sidebar for copyable client instructions. Lovbase exposes its own
Streamable HTTP server at `${BETTER_AUTH_URL}/mcp`; this is independent of the outbound
MCP connectors above. `MCP_SERVER_ENABLED` defaults to `true`; set it to `false` to disable
incoming MCP access. Production requires a canonical HTTPS `BETTER_AUTH_URL`; localhost
HTTP is supported for development. No additional hostname or service is required.

```sh
claude mcp add --transport http lovbase https://YOUR_LOVBASE_HOST/mcp
# In Claude Code: /mcp → lovbase → Authenticate
codex mcp add lovbase --url https://YOUR_LOVBASE_HOST/mcp
codex mcp login lovbase
```

For Cursor and other compatible clients:

```json
{ "mcpServers": { "lovbase": { "url": "https://YOUR_LOVBASE_HOST/mcp" } } }
```

VS Code uses `servers` instead of `mcpServers` and adds `"type": "http"` to the server.
Clients must support Streamable HTTP, OAuth authorization code with PKCE S256, and dynamic
registration as a public client (`token_endpoint_auth_method: none`). Discovery endpoints
are `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server`;
the authorization server exposes `/authorize`, `/token`, `/register`, and `/revoke`.

The browser consent page grants access to **all projects owned by the signed-in account,
including future projects**. Clients can create projects/apps, query and change data, propose
schema changes, read/write source, invoke the Lovbase Agent, preview, build, and publish.
Project/app deletion, unpublishing, and destructive schema approval stay in the web app.
Database queries use read-only transactions; writes use the existing workspace database role.

`start_agent_run`, `preview_app`, `build_app` and `publish_app` return `taskId`; poll `get_task`
for progress/results. Supply a unique `requestId` and reuse it only for identical retries.
Agent turns share the project's conversation and credit billing. Builds and publishing do not
invoke a model. `cancel_task` cancels queued operations or running Agent turns; application
operations cannot be cancelled after execution starts. Existing PostgreSQL/Redis/worker and
sandbox configuration is required for these operations. Persisted jobs survive web restarts;
interrupted worker executions are reported rather than silently repeated.

`read_file`/`list_files` return a source version; pass it as `expectedVersion` to `write_file`.
Concurrent edits fail with a conflict instead of overwriting newer source. Source access rejects
traversal, symlinks, internal instruction files and credential files.

Manage authorized clients under **Account → Authorized MCP clients**. Revoking a grant
immediately blocks new calls and refreshes; already accepted tasks continue and can be stopped
in Lovbase. Access tokens last one hour, rotating refresh tokens 30 days, pending authorization
requests ten minutes and authorization codes five minutes. Tokens are stored as hashes. A reused
refresh token revokes its grant. Audit records contain identity, operation, target and outcome,
not credentials, SQL bodies or file contents. Tables are created by the existing idempotent
startup migrations. The feature does not configure local client installations automatically.

When upgrading, disable incoming MCP temporarily, update both web and all worker processes, then enable it. Application operations use a separate `app-operations` queue; existing Agent jobs retain the `turns` queue. OAuth endpoints use peer-based shared limits (30 registrations and 300 authorization/token/revocation requests per minute per peer); tools also enforce per-account limits.
