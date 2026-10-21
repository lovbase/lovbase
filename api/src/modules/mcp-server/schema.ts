/** Inbound MCP credentials are deliberately separate from outbound connector credentials. */
export const mcpServerSchema = [
  `CREATE TABLE IF NOT EXISTS public.lb_mcp_clients (
    id text PRIMARY KEY, metadata jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_mcp_grants (
    id text PRIMARY KEY, user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    client_id text NOT NULL REFERENCES public.lb_mcp_clients(id),
    created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz, revoked_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS lb_mcp_grants_user ON public.lb_mcp_grants(user_id)`,
  `CREATE TABLE IF NOT EXISTS public.lb_mcp_authorizations (
    id text PRIMARY KEY, client_id text NOT NULL REFERENCES public.lb_mcp_clients(id),
    params jsonb NOT NULL, user_id text REFERENCES public."user"(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL, consumed_at timestamptz,
    code_hash text UNIQUE, code_expires_at timestamptz, grant_id text REFERENCES public.lb_mcp_grants(id)
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_mcp_tokens (
    hash text PRIMARY KEY, grant_id text NOT NULL REFERENCES public.lb_mcp_grants(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('access','refresh')), expires_at timestamptz NOT NULL,
    consumed_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS lb_mcp_tokens_grant ON public.lb_mcp_tokens(grant_id)`,
  `CREATE TABLE IF NOT EXISTS public.lb_mcp_server_audit (
    id bigserial PRIMARY KEY, user_id text NOT NULL, client_id text NOT NULL,
    tool text NOT NULL, project_id text, app_id text, ok boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE public.lb_mcp_server_audit ADD COLUMN IF NOT EXISTS task_id text`,
  `ALTER TABLE public.lb_jobs ADD COLUMN IF NOT EXISTS result jsonb`,
]
