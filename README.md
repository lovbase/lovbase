# Lovbase

**English** · [简体中文](./README.zh-CN.md)

**Describe what you need in a sentence and get a real Postgres database with a working app on top — change your mind later and not one row of existing data is lost.**

> ⚠️ Closed source, in development. Validating the MVP.

## How it works

Natural language → an IR with stable ids → a deterministic diff → whitelisted DDL → real Postgres.

- The LLM never writes SQL. It only produces the IR (`core/src/ir.ts`), which deterministic code compiles.
- Renames are recognised as `RENAME` (that is what the stable ids are for), not as drop-and-recreate.
- Destructive changes (dropping a table or column, changing a type) wait for the workspace owner to confirm them in the UI.
- Every project gets its own Postgres schema (`p_<id>`) plus a role that holds DML rights and nothing else (`ws_<id>`).

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
docker compose up -d                 # Postgres on :5433
cp .env.example app/.env             # fill in LLM_* or ANTHROPIC_API_KEY; SQL_ROLE_PASSWORD can be anything
bun install
docker build -f sandbox/Dockerfile -t lovbase-sandbox:local sandbox   # the sandbox image, once
bun run runner                       # sandbox runner on :8788 (starts containers via local Docker)
bun run dev                          # rspack watching api/ + vite dev, on localhost:3000
bun run lint                         # oxlint, including the layering rules
bun run typecheck                    # api and app
bun run test                         # the core engine + backend unit tests
bun run eval                         # the modelling evals (makes real LLM calls)
```

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
docker compose -f docker-compose.private.yml up -d                     # app + postgres + sandbox-runner
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

### 1. Railway: the app + Postgres

Create a project, add a Postgres service, then add a service from this repository (root `Dockerfile`;
`railway.toml` is already set up). Pick a Railway region close to your Cloudflare containers so the sandbox's
callbacks to the app take a shorter path. Environment variables:

```
DATABASE_URL            Postgres private connection string (the account needs CREATEROLE)
SQL_ROLE_PASSWORD       a strong password; the lovbase_sql role is created on first boot
BETTER_AUTH_SECRET
BETTER_AUTH_URL         https://your-domain
SANDBOX_URL             whatever step 2 deploys to (https://lovbase.app)
SANDBOX_INTERNAL_TOKEN  must match the sandbox Worker's INTERNAL_TOKEN
ADMIN_EMAILS
LLM_BASE_URL LLM_API_KEY LLM_MODEL   the platform default model; Pro users can BYOK
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

- **Credits.** One conversation costs 1 credit; one Boris UI build costs 5. Free users get 30 a month, so at
  most 6 UI builds. This is the per-user ceiling and by far the most effective control.
- **`max_instances`** (`sandbox/wrangler.jsonc`): how many containers may run at once. Containers are billed by
  vCPU-second and memory-second and are the only cost that can run away on its own, so this number is the hard
  ceiling.
- **`SANDBOX_SLEEP_AFTER`**: how long an idle container survives, 5 minutes by default. Anyone actually looking
  at a preview keeps renewing it, so shortening this is safe; the cost is a cold start when reopening an old one.

Container size can come down too — `instance_type` goes `standard-1` → `basic` → `dev` → `lite` — but Boris runs
`bun install` and Vite, so verify on a test project before dropping it.

**To cap the bill absolutely**, skip Cloudflare Containers and use the bundled Docker runner on a
fixed-price server (`docker-compose.runner.yml`), then point the app's `SANDBOX_URL` at it. The cost is losing
static-site publishing, and having to set up wildcard subdomains yourself.

### 4. Payments (optional)

Set the Stripe key and the four price ids, then point the webhook at `https://your-domain/api/billing/webhook`.
With none of that configured, the upgrade button records intent and charges nothing.

## Structure

Four packages, split by deployment unit: `core` is the pure engine, `api` is the backend, `app` is the
interface, and `sandbox` is the service that runs generated apps.

```
core/src/             IR + an id-based differ + a whitelisted DDL generator. Pure functions, anyone may depend on it
core/src/plans.ts     Plans, prices and credit costs (defined once, shared by both sides)
core/src/templates.ts Home page templates (rendered by the frontend, seeded as demos by the backend)

api/                  The NestJS backend. Runs embedded in the app process, or on its own via `node dist/main.js`
  src/config/         Every environment variable, declared here and validated at boot
  src/database/       Two process-wide pools + table creation
  src/common/         Domain errors, the Express⇄fetch bridge, the global auth guard (@Public opts out)
  src/modules/        auth · projects · apps · modeling · data · sql · roles · credits
                      billing · llm · sandbox · agent · analytics · demo · ingest · limits
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
/pricing              Pricing
/projects             Project list      /projects/:id   Builder
/share/:token         Public share
/settings             Account and usage  /admin          Admin console
/api/data/:ws/{sql,schema,events}   The data API (the older /w/:ws/* paths still work)
/api/billing/webhook  Stripe subscription events
```

## Credits and plans

One agent conversation costs 1 credit; having Boris build the UI costs 5. Credits are granted per plan per
period, and an admin can hand out extra from /admin. Plans, prices, credits and caps are defined exactly once,
in `core/src/plans.ts`.

Payments go through Stripe Checkout and are entirely gated by environment variables:

```
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRICE_PRO_MONTHLY=price_...      STRIPE_PRICE_PRO_YEARLY=price_...
STRIPE_PRICE_BUSINESS_MONTHLY=price_... STRIPE_PRICE_BUSINESS_YEARLY=price_...
```

With none of them set, the upgrade button records intent and takes no money.
