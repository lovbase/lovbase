# Deploying lovbase

Two deployments are supported, and they differ in one decision: where the sandbox that runs
generated apps lives.

| | Hosted | Self-hosted |
|---|---|---|
| App + Postgres + Redis | Railway | `docker-compose.private.yml` |
| Attachments | Cloudflare R2 | MinIO (in the same compose file) |
| Sandbox | Cloudflare Worker + Containers | Docker runner on the same machine |
| Published apps | R2, via the Worker | not available without the Worker |

Both run the same code. Object storage is reached over the S3 API either way, so R2 and MinIO
are interchangeable to the application — the only difference is `S3_ENDPOINT`.

## Hosted: Railway + Cloudflare

### What goes where

Railway runs one service built from the root `Dockerfile`, next to Postgres and Redis services. Cloudflare
holds the R2 buckets and the sandbox Worker. Railway cannot run the sandbox: the runner needs the
host's Docker socket to start a container per generated app, and Railway does not offer one.

### Environment

Set on the Railway app service. `api/src/config/config.service.ts` is the full list and validates
at boot; these are the ones a deployment has to supply.

| Variable | Notes |
|---|---|
| `NODE_ENV` | `production`. Turns on the check below. |
| `PORT` | `3008`. Railway injects `8080` otherwise, and the service domain's target port has to agree — a mismatch is a 502 with a healthy container behind it. |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}`. Private connection shared by BullMQ, transient run streams and sandbox leases; Redis must use `maxmemory-policy noeviction`. |
| `RUN_CHUNKS_TTL_SECONDS` | Default `7200`, minimum `60`. Renewed during a run and reset when its recording finishes. |
| `RUN_CHUNKS_MAX_BYTES` | Default `33554432` (32 MiB) per run. Exceeding it disables that recording; the turn and transcript continue. |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | The app's public URL — the custom domain once there is one, not the platform's |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Any other hostname the app answers on, comma-separated. Better Auth trusts only `BETTER_AUTH_URL`'s origin, so a second domain fails every sign-in with `Invalid origin` and nothing else says why. |
| `SQL_ROLE_PASSWORD` | `openssl rand -base64 32` |
| `SANDBOX_INTERNAL_TOKEN` | `openssl rand -base64 32`. The **same value** has to reach the Worker, where it is called `INTERNAL_TOKEN` — two names for one shared secret (`sandbox/src/index.ts` reads `env.INTERNAL_TOKEN`): `cd sandbox && bunx wrangler secret put INTERNAL_TOKEN`. Setting `SANDBOX_INTERNAL_TOKEN` on the Worker instead creates a secret nothing reads, and every build then fails with `unauthorized`. |
| `SANDBOX_URL` | `https://lovbase.app` — the Worker's apex route |
| `APPS_DOMAIN` | `lovbase.app` |
| `S3_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | The attachments bucket |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | R2 → Manage API Tokens, **Object Read & Write scoped to that one bucket** |
| `S3_REGION` | `auto` |
| `CLOUDFLARE_API_TOKEN` | Traffic figures for published apps. Needs **Analytics · Read** — the token that deploys the Worker does not have it, and without it the analytics pane shows engagement only. |
| `CLOUDFLARE_ACCOUNT_ID` | The same account the Worker is on. |
| `SANDBOX_SLOT_COUNT` | Redis-managed container slots, default `5`. Keep equal to or below Cloudflare `max_instances` (currently 5). |
| `TURN_WORKER_CONCURRENCY` | BullMQ turn processors per Worker, default `20`. This may exceed the slot count; capacity is enforced by leases. |
| `CONTAINER_WARM_GRACE_SECONDS` | Keep a completed turn's container warm while the user continues editing, default `120`. |
| `SANDBOX_LEASE_TTL_SECONDS` / `SANDBOX_LEASE_RENEW_SECONDS` | Lease TTL and renewal cadence, defaults `45` / `10`. |
| `MAX_ACTIVE_BUILDS` | Deprecated compatibility setting. New deployments use `SANDBOX_SLOT_COUNT`. |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | Set to `1200` on the Worker service so active BullMQ jobs can drain during deploys. |

`BETTER_AUTH_SECRET`, `SQL_ROLE_PASSWORD` and `SANDBOX_INTERNAL_TOKEN` have development defaults
so `bun run dev` needs no setup. Those defaults are in a public repository, and
`BETTER_AUTH_SECRET` derives the key that encrypts users' own provider API keys — so in
production the app refuses to start if any of them is still the default, naming all of them at
once rather than one per failed boot.

Create two Railway services from the same repository and image. The public Web service uses
`railway.toml`; the private Worker service uses `railway.worker.toml` and has no domain. Give both
the same PostgreSQL, Redis, storage, sandbox and model variables. Only the Worker registers BullMQ
consumers; restarting Web does not interrupt queued or running turns.

### Redis run recordings and direct cutover

Provision Redis and configure `REDIS_URL` before starting this version. Stop the old app instances
before starting the new version: schema initialization runs `DROP TABLE IF EXISTS public.lb_run_chunks`,
discarding **all** old increment recordings and their indexes in one operation. There is no backfill,
dual-write, or PostgreSQL recording fallback. `lb_chat` and `lb_runs` are retained. Old runs without
a recording use the saved transcript; new runs use Redis Streams exclusively.

Each run uses `lb:run:{runId}:chunks`. Writes and expiry are atomic; a heartbeat renews expiry even
while a tool is quiet. Completed recordings expire two hours after completion by default; abandoned
ones expire after their last renewal. Readers use independent cursors, not consumer groups.
Redis failure, missing history, and capacity limits fall back to saved-transcript polling without
stopping generation. Redis is not the durable source for conversation history.

Use a dedicated Redis with `maxmemory` and `maxmemory-policy noeviction` so pressure rejects new
writes instead of silently evicting active recordings. The compose files start at 256 MiB with AOF;
size production memory for retained runs, Stream overhead, persistence buffers, and peak concurrency.
Monitor used memory, rejected writes, connected clients, recording failures and replay failures.
Every remote replay holds one blocking Redis connection; allow for this in the connection limit.

### Buckets

Two, with different readers:

- **Attachments** (`S3_BUCKET`) — private. Read through `/api/files/*`, which applies the same
  project check as the rest of the project. Never make it public: the key alone would be enough
  to read anyone's uploads.
- **Published apps** (`lovbase-apps`, bound as `APPS` in `sandbox/wrangler.jsonc`) — read by the
  Worker through its binding, so this one is not public either.

The app never creates buckets, and its credentials should not be allowed to.

### CI

`.github/workflows/ci.yml` runs on pull requests. `deploy.yml` runs the same checks on master and
deploys only if they pass — Railway's own GitHub integration would deploy whatever was pushed,
including a commit whose tests are red.

Needed in the repository:

- Secret `RAILWAY_TOKEN` — a Railway **project** token (project Settings → Tokens), not an
  account token. It reaches one project and nothing else.
- Variable `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID` — only if you go back to the API-driven
  deploy; the current job addresses the service by name.

A project token can do less than the dashboard: it can read status, read and write variables,
create services, and run `railway up`. It cannot connect a GitHub repo (`serviceConnect` is
unauthorized) and `railway up` returns 404 until the service has an instance, which a service
only gets once it has a source. Creating the service with a source in the same call is the way
through that.

### Sandbox

Deployed separately by `.github/workflows/deploy-sandbox.yml` when anything under `sandbox/`
changes. Needs repository secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit, plus Workers R2
Storage: Edit for the published-apps bucket) and `CLOUDFLARE_ACCOUNT_ID`. An R2 S3 credential is
not one of these — it only signs S3 requests and cannot manage Workers, and the API-token form
shown on the R2 page fails `/user/tokens/verify` outright.

`max_instances` in `sandbox/wrangler.jsonc` is a hard cap on concurrent sandboxes and the main
cost control. It is also an availability limit worth understanding: a container that is running
occupies a slot whether or not anyone is using it, and every call that could free one — the
project-destroy route included — needs a slot of its own to run. At the cap, the system cannot
be cleared from the outside; `wrangler containers instances <id>` is the way to see what is
holding them, and leaving it completely untouched for the idle window is the way out.

## Self-hosted

```bash
export BETTER_AUTH_SECRET=... SQL_ROLE_PASSWORD=... S3_SECRET_KEY=... SANDBOX_INTERNAL_TOKEN=...

# The image generated apps run inside — this is SANDBOX_IMAGE, not the runner service, which
# compose builds itself from runner/Dockerfile.runner.
docker build -f sandbox/Dockerfile -t lovbase-sandbox:local sandbox

docker compose -f docker-compose.private.yml up -d
```

Six services: Web, Worker, Postgres, Redis, MinIO (with its bucket created at startup), and the sandbox
runner. No Cloudflare account is involved.

Sizing is set by the sandbox: each generated app gets its own container, capped at 2 GiB, and an
active one really does use over a gigabyte. The runner sleeps a container after
`SANDBOX_SLEEP_AFTER` (default 5m) of no API calls *and* no network traffic — the second signal
matters because someone watching a preview talks to the container's published port and never
reaches the runner. Idle containers are stopped, not removed, so the project volume survives and
waking one is a start. Budget on concurrent apps rather than total apps: 8 GiB is a reasonable
floor, 4 GiB is tight.

Put gVisor (`runsc`) under Docker before letting anyone else use it. Container isolation alone is
not a boundary you want between tenants.

## Local development

`docker compose up -d` brings up Postgres, Redis and MinIO and creates the bucket. Point `app/.env` at
them; `.env.example` has the block to copy. If something already holds port 9000,
`MINIO_PORT=9200 docker compose up -d` and change `S3_ENDPOINT` to match.

Without `S3_*` configured the app still runs — attachments simply stay inline as base64, which is
the behaviour that puts screenshots in Postgres and re-sends them to the model on every later
turn of the conversation. Fine for a quick local run, not for anything that keeps data.
