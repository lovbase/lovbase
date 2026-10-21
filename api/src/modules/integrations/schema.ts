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
  `ALTER TABLE public.lb_connections ADD COLUMN IF NOT EXISTS toolkit text NOT NULL DEFAULT 'googlesheets'`,
  `ALTER TABLE public.lb_connections ADD COLUMN IF NOT EXISTS app_name text NOT NULL DEFAULT 'Google Sheets'`,
  `ALTER TABLE public.lb_connections ADD COLUMN IF NOT EXISTS logo text`,
  `ALTER TABLE public.lb_connections ADD COLUMN IF NOT EXISTS auth_scheme text NOT NULL DEFAULT 'OAUTH2'`,
  `ALTER TABLE public.lb_connections ADD COLUMN IF NOT EXISTS identity text`,
  `ALTER TABLE public.lb_connections ADD COLUMN IF NOT EXISTS identity_id text`,
  `ALTER TABLE public.lb_connections ADD COLUMN IF NOT EXISTS synced_at timestamptz`,
  `ALTER TABLE public.lb_connections ADD COLUMN IF NOT EXISTS connected_at timestamptz`,
  // Preserve established accounts across the upgrade, including revoked accounts and delete retries.
  // First-time pending/failed authorizations remain attempts rather than visible connected accounts.
  `UPDATE public.lb_connections SET connected_at = COALESCE(synced_at, created_at)
    WHERE connected_at IS NULL AND state IN ('active', 'expired', 'disconnected')`,
  `CREATE TABLE IF NOT EXISTS public.lb_connection_attempts (
    state text PRIMARY KEY, user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    connection_id text NOT NULL REFERENCES public.lb_connections(id) ON DELETE CASCADE,
    account_id text NOT NULL UNIQUE, return_path text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), consumed_at timestamptz
  )`,
  // Legacy callbacks remain valid across the upgrade.
  `INSERT INTO public.lb_connection_attempts(state, user_id, connection_id, account_id, return_path, created_at)
    SELECT callback_state, user_id, id, account_id, return_path, created_at FROM public.lb_connections
    WHERE callback_state IS NOT NULL ON CONFLICT DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS public.lb_project_connection_accounts (
    project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    connection_id text NOT NULL REFERENCES public.lb_connections(id) ON DELETE CASCADE,
    PRIMARY KEY(project_id, connection_id)
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_project_connection_defaults (
    project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    toolkit text NOT NULL, connection_id text REFERENCES public.lb_connections(id) ON DELETE SET NULL,
    PRIMARY KEY(project_id, toolkit)
  )`,
  // Drain the legacy table once; leaving it populated would resurrect disabled bindings at startup.
  `INSERT INTO public.lb_project_connection_accounts SELECT project_id, connection_id FROM public.lb_project_connections ON CONFLICT DO NOTHING`,
  `INSERT INTO public.lb_project_connection_defaults(project_id, toolkit, connection_id)
    SELECT project_id, 'googlesheets', connection_id FROM public.lb_project_connections ON CONFLICT DO NOTHING`,
  `DELETE FROM public.lb_project_connections`,
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
  `CREATE TABLE IF NOT EXISTS public.lb_mcp_registries (
    id text PRIMARY KEY, user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    url text NOT NULL, display_name text NOT NULL, bearer_token_enc text,
    state text NOT NULL DEFAULT 'pending', last_synced_at timestamptz, last_error text,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, url)
  )`,
  `CREATE INDEX IF NOT EXISTS lb_mcp_registries_user ON public.lb_mcp_registries(user_id)`,
  `CREATE TABLE IF NOT EXISTS public.lb_mcp_servers (
    id text PRIMARY KEY, registry_id text NOT NULL REFERENCES public.lb_mcp_registries(id) ON DELETE CASCADE,
    remote_id text NOT NULL, name text NOT NULL, description text, version text,
    endpoint text, transport text NOT NULL DEFAULT 'streamable_http', metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    state text NOT NULL DEFAULT 'unknown', last_synced_at timestamptz,
    UNIQUE (registry_id, remote_id)
  )`,
  `CREATE INDEX IF NOT EXISTS lb_mcp_servers_registry ON public.lb_mcp_servers(registry_id)`,
  `ALTER TABLE public.lb_mcp_servers ALTER COLUMN registry_id DROP NOT NULL`,
  `ALTER TABLE public.lb_mcp_servers ADD COLUMN IF NOT EXISTS user_id text REFERENCES public."user"(id) ON DELETE CASCADE`,
  `UPDATE public.lb_mcp_servers s SET user_id = r.user_id FROM public.lb_mcp_registries r WHERE s.registry_id = r.id AND s.user_id IS NULL`,
  `ALTER TABLE public.lb_mcp_servers ALTER COLUMN user_id SET NOT NULL`,
  `ALTER TABLE public.lb_mcp_servers ADD COLUMN IF NOT EXISTS auth_type text NOT NULL DEFAULT 'none'`,
  `ALTER TABLE public.lb_mcp_servers ADD COLUMN IF NOT EXISTS credentials_enc text`,
  `ALTER TABLE public.lb_mcp_servers ADD COLUMN IF NOT EXISTS account_enabled boolean NOT NULL DEFAULT true`,
  `ALTER TABLE public.lb_mcp_servers ADD COLUMN IF NOT EXISTS last_error text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lb_mcp_direct_endpoint ON public.lb_mcp_servers(user_id, endpoint) WHERE registry_id IS NULL`,
  `CREATE TABLE IF NOT EXISTS public.lb_mcp_oauth_sessions (
    state text PRIMARY KEY, user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    server_id text NOT NULL REFERENCES public.lb_mcp_servers(id) ON DELETE CASCADE,
    project_id text REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    return_path text NOT NULL, verifier_enc text, expires_at timestamptz NOT NULL,
    consumed_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS lb_mcp_oauth_server ON public.lb_mcp_oauth_sessions(server_id)`,
  `CREATE TABLE IF NOT EXISTS public.lb_project_mcp_servers (
    project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    server_id text NOT NULL REFERENCES public.lb_mcp_servers(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true, allowed_tools jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, server_id)
  )`,
  `CREATE INDEX IF NOT EXISTS lb_project_mcp_servers_server ON public.lb_project_mcp_servers(server_id)`,
  `CREATE TABLE IF NOT EXISTS public.lb_mcp_approvals (
    id text PRIMARY KEY, user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    run_id text, tool_call_id text, server_id text NOT NULL REFERENCES public.lb_mcp_servers(id) ON DELETE CASCADE,
    tool_name text NOT NULL, args jsonb NOT NULL, args_hash text NOT NULL,
    state text NOT NULL DEFAULT 'pending', expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), decided_at timestamptz, executed_at timestamptz
  )`,
  `ALTER TABLE public.lb_mcp_approvals ADD COLUMN IF NOT EXISTS tool_call_id text`,
  `ALTER TABLE public.lb_mcp_approvals ADD COLUMN IF NOT EXISTS executed_at timestamptz`,
  `CREATE INDEX IF NOT EXISTS lb_mcp_approvals_project ON public.lb_mcp_approvals(project_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS public.lb_mcp_audit (
    id bigserial PRIMARY KEY, user_id text REFERENCES public."user"(id) ON DELETE SET NULL,
    project_id text REFERENCES public.lb_projects(id) ON DELETE SET NULL, server_id text,
    registry_id text, tool_name text, action text NOT NULL, state text NOT NULL,
    duration_ms int, result_bytes int, error text, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS lb_mcp_audit_project ON public.lb_mcp_audit(project_id, created_at DESC)`,
]
