import { Injectable, Logger, type OnModuleInit } from '@nestjs/common'
import type pg from 'pg'
import { InjectPool } from './pool.provider'

/**
 * Creates every table the platform needs, plus Better Auth's own (it ships no runtime migrator).
 * Idempotent and additive — `IF NOT EXISTS` throughout — so it is safe to run on every boot and
 * there is no migration step to forget on a new database.
 */
@Injectable()
export class SchemaService implements OnModuleInit {
  private readonly log = new Logger('schema')
  private running: Promise<void> | null = null

  constructor(@InjectPool() private readonly pool: pg.Pool) {}

  /** Best effort at boot; a database that is still starting up must not crash the process. */
  async onModuleInit() {
    try { await this.ready() } catch (err) {
      this.log.warn(`schema init deferred: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Awaited by every service before its first query. Runs once; retries if the first attempt failed. */
  ready(): Promise<void> {
    this.running ??= this.migrate().catch((err) => { this.running = null; throw err })
    return this.running
  }

  private async migrate() {
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_projects (
        id text PRIMARY KEY,
        owner_id text NOT NULL,
        name text NOT NULL DEFAULT '',
        ir jsonb NOT NULL,
        share_token text UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`CREATE INDEX IF NOT EXISTS lb_projects_owner ON public.lb_projects(owner_id)`)
      await this.pool.query(`ALTER TABLE public.lb_projects ADD COLUMN IF NOT EXISTS api_token text UNIQUE`)
      await this.pool.query(`ALTER TABLE public.lb_projects ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false`)
      // A workspace (project) owns the data; it can have many apps (frontends), each with its own sandbox.
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_apps (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
        name text NOT NULL DEFAULT '主应用',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`CREATE INDEX IF NOT EXISTS lb_apps_project ON public.lb_apps(project_id, created_at)`)
      // Published apps get a stable subdomain; the preview host changes whenever a container is recreated.
      await this.pool.query(`ALTER TABLE public.lb_apps ADD COLUMN IF NOT EXISTS slug text`)
      await this.pool.query(`ALTER TABLE public.lb_apps ADD COLUMN IF NOT EXISTS published_at timestamptz`)
      // When a cover was last photographed. Distinct from published_at: publishing is what
      // triggers a photograph, but the photograph can fail, and an app published before this
      // existed never had one taken at all.
      await this.pool.query(`ALTER TABLE public.lb_apps ADD COLUMN IF NOT EXISTS cover_at timestamptz`)
      // When a built copy was last put in object storage. Doubles as the cache version in the URL,
      // so a rebuilt snapshot is never served from a stale cache.
      await this.pool.query(`ALTER TABLE public.lb_apps ADD COLUMN IF NOT EXISTS snap_at timestamptz`)
      await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS lb_apps_slug ON public.lb_apps(slug) WHERE slug IS NOT NULL`)
      // Backfill: every existing project gets a default app whose id equals the project id (matches existing sandboxes).
      await this.pool.query(`INSERT INTO public.lb_apps (id, project_id, name) SELECT id, id, '主应用' FROM public.lb_projects p WHERE NOT EXISTS (SELECT 1 FROM public.lb_apps a WHERE a.project_id = p.id) ON CONFLICT DO NOTHING`)
      // One level of folders per owner; a project sits in at most one folder.
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_folders (
        id text PRIMARY KEY,
        owner_id text NOT NULL,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`ALTER TABLE public.lb_projects ADD COLUMN IF NOT EXISTS folder_id text REFERENCES public.lb_folders(id) ON DELETE SET NULL`)
      await this.pool.query(`ALTER TABLE public.lb_projects ADD COLUMN IF NOT EXISTS starred boolean NOT NULL DEFAULT false`)
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_log (
        id serial PRIMARY KEY,
        project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
        role text NOT NULL,
        content jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`CREATE INDEX IF NOT EXISTS lb_log_project ON public.lb_log(project_id, id)`)
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_chat (
        project_id text PRIMARY KEY REFERENCES public.lb_projects(id) ON DELETE CASCADE,
        messages jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`)
      // Product analytics for generated apps: one row per event, visitor id is a daily-rotating hash.
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_events (
        id bigserial PRIMARY KEY,
        project_id text NOT NULL,
        ts timestamptz NOT NULL DEFAULT now(),
        type text NOT NULL,
        path text NOT NULL DEFAULT '/',
        referrer text,
        country text,
        device text,
        visitor text NOT NULL,
        duration_ms int
      )`)
      await this.pool.query(`CREATE INDEX IF NOT EXISTS lb_events_project_ts ON public.lb_events(project_id, ts)`)
      // Better Auth's own tables. It has no runtime migrator, so a fresh database would otherwise
      // fail on the first request; these match what the installed version expects.
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public."user" (
        id text PRIMARY KEY,
        name text NOT NULL,
        email text NOT NULL UNIQUE,
        "emailVerified" boolean NOT NULL DEFAULT false,
        image text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.session (
        id text PRIMARY KEY,
        "expiresAt" timestamptz NOT NULL,
        token text NOT NULL UNIQUE,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        "ipAddress" text,
        "userAgent" text,
        "userId" text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE
      )`)
      await this.pool.query(`CREATE INDEX IF NOT EXISTS "session_userId_idx" ON public.session("userId")`)
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.account (
        id text PRIMARY KEY,
        "accountId" text NOT NULL,
        "providerId" text NOT NULL,
        "userId" text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
        "accessToken" text,
        "refreshToken" text,
        "idToken" text,
        "accessTokenExpiresAt" timestamptz,
        "refreshTokenExpiresAt" timestamptz,
        scope text,
        password text,
        issuer text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`CREATE INDEX IF NOT EXISTS "account_userId_idx" ON public.account("userId")`)
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.verification (
        id text PRIMARY KEY,
        identifier text NOT NULL,
        value text NOT NULL,
        "expiresAt" timestamptz NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`CREATE INDEX IF NOT EXISTS verification_identifier_idx ON public.verification(identifier)`)

      // Account-level fields on Better Auth's user table + a global key/value settings table for admins.
      await this.pool.query(`ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS "isAdmin" boolean NOT NULL DEFAULT false`)
      // Who reached for a paid thing while payments were off. Its own table rather than a line in
      // some project's activity log: this is the evidence the price is worth anything, and it has
      // to be readable on its own — and loggable for someone who has not made a project yet.
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_interest (
        id text PRIMARY KEY,
        user_id text REFERENCES public."user"(id) ON DELETE SET NULL,
        kind text NOT NULL,
        target text NOT NULL DEFAULT '',
        source text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`CREATE INDEX IF NOT EXISTS lb_interest_seen ON public.lb_interest(created_at DESC)`)
      await this.pool.query(`ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free'`)
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_settings (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`)
      // Billing: plan period + Stripe linkage on the user row, and an append-only credit ledger.
      await this.pool.query(`ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS plan_since timestamptz`)
      await this.pool.query(`ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS period_start timestamptz`)
      await this.pool.query(`ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS credits_bonus int NOT NULL DEFAULT 0`)
      await this.pool.query(`ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS stripe_customer_id text`)
      await this.pool.query(`ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS stripe_subscription_id text`)
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_credits (
        id bigserial PRIMARY KEY,
        user_id text NOT NULL,
        project_id text,
        kind text NOT NULL,
        credits int NOT NULL,
        model text,
        note text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`CREATE INDEX IF NOT EXISTS lb_credits_user_ts ON public.lb_credits(user_id, created_at DESC)`)
      // Credits coming *in*: a pack someone bought, or a grant an admin handed over. The spend
      // ledger above cannot hold these — it is summed as "used this period", and a negative row
      // there would quietly refund usage. `ref` is the Stripe session id, unique per purchase, so
      // a webhook Stripe retries three times still grants the credits once.
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_credit_grants (
        id bigserial PRIMARY KEY,
        user_id text NOT NULL,
        credits int NOT NULL,
        source text NOT NULL,
        amount_usd numeric(12,2) NOT NULL DEFAULT 0,
        ref text,
        note text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`CREATE INDEX IF NOT EXISTS lb_credit_grants_user_ts ON public.lb_credit_grants(user_id, created_at DESC)`)
      await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS lb_credit_grants_ref ON public.lb_credit_grants(ref) WHERE ref IS NOT NULL`)
    // What the turn actually consumed. Without these the ledger records that something was charged
    // but not whether the charge covered the spend, which is the only question that matters.
    await this.pool.query(`ALTER TABLE public.lb_credits ADD COLUMN IF NOT EXISTS in_tokens bigint NOT NULL DEFAULT 0`)
    await this.pool.query(`ALTER TABLE public.lb_credits ADD COLUMN IF NOT EXISTS out_tokens bigint NOT NULL DEFAULT 0`)
    await this.pool.query(`ALTER TABLE public.lb_credits ADD COLUMN IF NOT EXISTS container_ms bigint NOT NULL DEFAULT 0`)
    // Provider cost in USD before the tier markup — the number to compare revenue against.
    await this.pool.query(`ALTER TABLE public.lb_credits ADD COLUMN IF NOT EXISTS cost_usd numeric(12,6) NOT NULL DEFAULT 0`)
    await this.pool.query(`ALTER TABLE public.lb_credits ADD COLUMN IF NOT EXISTS byok boolean NOT NULL DEFAULT false`)
      // One row per project marking an agent turn that is still running server-side, so a browser
      // refresh can tell "the model is still working" from "the turn ended".
      // A sandbox container loses its filesystem when it is evicted, so the generated source is
      // mirrored here after every change and written back when a fresh container comes up.
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_app_files (
        app_id text PRIMARY KEY,
        files jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_runs (
        project_id text PRIMARY KEY,
        started_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      )`)
      await this.pool.query(`ALTER TABLE public.lb_runs ADD COLUMN IF NOT EXISTS progress jsonb`)
      // A turn's identity, so its stream can be addressed after the connection that made it is
      // gone. `lb_runs` is keyed by project — one live turn each — but the chunks below outlive
      // the row's current contents and must not be read as part of the next turn.
      await this.pool.query(`ALTER TABLE public.lb_runs ADD COLUMN IF NOT EXISTS id text`)
      // The last time the process running this turn said it was still there. A row left open by a
      // process that died used to be believed for the whole build budget; now it is believed for
      // as long as someone keeps saying so.
      await this.pool.query(`ALTER TABLE public.lb_runs ADD COLUMN IF NOT EXISTS touched_at timestamptz`)
      /**
       * The turn as it was sent, kept so a reload can be handed the same thing again.
       *
       * The bytes are the UI message stream verbatim — replaying them in order reproduces the
       * response exactly, which is what makes a resumed turn identical to one that was never
       * interrupted rather than a reconstruction that resembles it.
       */
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_run_chunks (
        run_id text NOT NULL,
        seq integer NOT NULL,
        chunk text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (run_id, seq)
      )`)
      await this.pool.query(`CREATE INDEX IF NOT EXISTS lb_run_chunks_age ON public.lb_run_chunks(created_at)`)
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_user_settings (
        user_id text PRIMARY KEY,
        llm_base_url text,
        llm_api_key_enc text,
        llm_model text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`CREATE TABLE IF NOT EXISTS public.lb_pending (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
        next_ir jsonb NOT NULL,
        changes jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`)
      await this.pool.query(`ALTER TABLE public.lb_pending ADD COLUMN IF NOT EXISTS base_ir jsonb`)
    this.log.log('schema ready')
  }
}
