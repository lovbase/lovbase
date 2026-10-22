export const templateSchema = [
  `CREATE TABLE IF NOT EXISTS public.lb_template_instances (
    project_id text PRIMARY KEY REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    template_id text NOT NULL, version integer NOT NULL, locale text NOT NULL,
    user_id text NOT NULL, request_id text NOT NULL, demo boolean NOT NULL DEFAULT false,
    UNIQUE(user_id,request_id)
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_inventory_requests (
    project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    request_id text NOT NULL, input jsonb NOT NULL, result jsonb NOT NULL,
    PRIMARY KEY(project_id,request_id)
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_product_3d_requests (
    project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    request_id text NOT NULL, input jsonb NOT NULL, result jsonb NOT NULL,
    PRIMARY KEY(project_id,request_id)
  )`,
]
