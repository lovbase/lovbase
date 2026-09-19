# Deploying lovbase

Two deployments are supported, and they differ in one decision: where the sandbox that runs
generated apps lives.

| | Hosted | Self-hosted |
|---|---|---|
| App + Postgres | Railway | `docker-compose.private.yml` |
| Attachments | Cloudflare R2 | MinIO (in the same compose file) |
| Sandbox | Cloudflare Worker + Containers | Docker runner on the same machine |
| Published apps | R2, via the Worker | not available without the Worker |

Both run the same code. Object storage is reached over the S3 API either way, so R2 and MinIO
are interchangeable to the application — the only difference is `S3_ENDPOINT`.

## Hosted: Railway + Cloudflare

### What goes where

Railway runs one service built from the root `Dockerfile`, next to a Postgres service. Cloudflare
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
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | The app's public URL |
| `SQL_ROLE_PASSWORD` | `openssl rand -base64 32` |
| `SANDBOX_INTERNAL_TOKEN` | `openssl rand -base64 32`, and the **same value** must be set on the Worker: `cd sandbox && bunx wrangler secret put SANDBOX_INTERNAL_TOKEN` |
| `SANDBOX_URL` | `https://lovbase.app` — the Worker's apex route |
| `APPS_DOMAIN` | `lovbase.app` |
| `S3_ENDPOINT` | `https://<account_id>.r2.cloudflarestorage.com` |
| `S3_BUCKET` | The attachments bucket |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | R2 → Manage API Tokens, **Object Read & Write scoped to that one bucket** |
| `S3_REGION` | `auto` |

`BETTER_AUTH_SECRET`, `SQL_ROLE_PASSWORD` and `SANDBOX_INTERNAL_TOKEN` have development defaults
so `bun run dev` needs no setup. Those defaults are in a public repository, and
`BETTER_AUTH_SECRET` derives the key that encrypts users' own provider API keys — so in
production the app refuses to start if any of them is still the default, naming all of them at
once rather than one per failed boot.

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
changes. Needs repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. An R2 S3
credential is not one of these — it only signs S3 requests and cannot manage Workers.

## Self-hosted

```bash
export BETTER_AUTH_SECRET=... SQL_ROLE_PASSWORD=... S3_SECRET_KEY=... SANDBOX_INTERNAL_TOKEN=...
docker build -f sandbox/runner/Dockerfile.runner -t lovbase-sandbox:local sandbox
docker compose -f docker-compose.private.yml up -d
```

Four services: the app, Postgres, MinIO (with its bucket created at startup), and the sandbox
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

`docker compose up -d` brings up Postgres and MinIO and creates the bucket. Point `app/.env` at
them; `.env.example` has the block to copy. If something already holds port 9000,
`MINIO_PORT=9200 docker compose up -d` and change `S3_ENDPOINT` to match.

Without `S3_*` configured the app still runs — attachments simply stay inline as base64, which is
the behaviour that puts screenshots in Postgres and re-sends them to the model on every later
turn of the conversation. Fine for a quick local run, not for anything that keeps data.
