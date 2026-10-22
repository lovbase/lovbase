export const entitlementsSchema = [
  `CREATE TABLE IF NOT EXISTS public.lb_generation_runs (
    id text PRIMARY KEY, user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    app_id text NOT NULL REFERENCES public.lb_apps(id) ON DELETE CASCADE,
    model text NOT NULL, tier text NOT NULL, byok boolean NOT NULL, status text NOT NULL DEFAULT 'running',
    container_ms bigint, container_credits integer, container_cost double precision,
    created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz)`,
  `ALTER TABLE public.lb_jobs ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 2`,
  `CREATE TABLE IF NOT EXISTS public.lb_storage_files (
    key text PRIMARY KEY, user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    project_id text REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    category text NOT NULL, bytes bigint NOT NULL CHECK(bytes >= 0), updated_at timestamptz NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS lb_storage_owner ON public.lb_storage_files(user_id)`,
  `CREATE TABLE IF NOT EXISTS public.lb_storage_reservations (
    id text PRIMARY KEY, key text NOT NULL UNIQUE, user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    project_id text REFERENCES public.lb_projects(id) ON DELETE CASCADE, category text NOT NULL,
    bytes bigint NOT NULL, delta bigint NOT NULL, expires_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS public.lb_publish_reservations (
    app_id text PRIMARY KEY REFERENCES public.lb_apps(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS public.lb_direct_connections (
    project_id text PRIMARY KEY REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    role_name text NOT NULL UNIQUE, enabled boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now())`,
  `ALTER TABLE public.lb_credits ADD COLUMN IF NOT EXISTS idempotency_key text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lb_credit_idempotency ON public.lb_credits(idempotency_key) WHERE idempotency_key IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS public.lb_model_requests (
    id text PRIMARY KEY, run_id text NOT NULL, user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    model text NOT NULL, byok boolean NOT NULL, usage jsonb, credits integer NOT NULL DEFAULT 0,
    cost_usd double precision NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now())`,
  `ALTER TABLE public.lb_model_requests ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'build_app'`,
  `CREATE INDEX IF NOT EXISTS lb_model_run ON public.lb_model_requests(run_id)`,
]
