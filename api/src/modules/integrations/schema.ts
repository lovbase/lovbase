/** Additive migrations, shared by startup and the PostgreSQL integration tests. */
export const integrationSchema = [
  `CREATE TABLE IF NOT EXISTS public.lb_connections (
    id text PRIMARY KEY, user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    account_id text NOT NULL UNIQUE, auth_config_id text NOT NULL, label text NOT NULL,
    state text NOT NULL DEFAULT 'pending', callback_state text UNIQUE, return_path text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS lb_connections_user ON public.lb_connections(user_id)`,
  `CREATE TABLE IF NOT EXISTS public.lb_project_connections (
    project_id text PRIMARY KEY REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    connection_id text NOT NULL REFERENCES public.lb_connections(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_sheet_imports (
    id text PRIMARY KEY, project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    app_id text NOT NULL REFERENCES public.lb_apps(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    connection_id text REFERENCES public.lb_connections(id) ON DELETE SET NULL,
    source jsonb NOT NULL, snapshot jsonb NOT NULL, mapping jsonb NOT NULL, base_ir jsonb NOT NULL,
    version int NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'preview', entity_id text,
    job_id text, created_at timestamptz NOT NULL DEFAULT now(), imported_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS lb_sheet_imports_project ON public.lb_sheet_imports(project_id, created_at DESC)`,
]
