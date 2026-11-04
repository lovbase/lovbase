export const templateSchema = [
  `CREATE TABLE IF NOT EXISTS public.lb_template_instances (
    project_id text PRIMARY KEY REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    template_id text NOT NULL, version integer NOT NULL, locale text NOT NULL,
    user_id text NOT NULL, request_id text NOT NULL, demo boolean NOT NULL DEFAULT false,
    UNIQUE(user_id,request_id)
  )`,
  `ALTER TABLE public.lb_template_instances ADD COLUMN IF NOT EXISTS seed_revision integer`,
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
  `CREATE TABLE IF NOT EXISTS public.lb_ledger_requests (
    project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    request_id text NOT NULL, input jsonb NOT NULL, result jsonb NOT NULL,
    PRIMARY KEY(project_id,request_id)
  )`,
  // Templates people publish from their own apps. A snapshot of the schema and the source, never
  // the rows: what someone typed into their app is theirs, and a reviewer should not have to look
  // through it. One per app, so publishing again replaces the snapshot and goes back to review.
  `CREATE TABLE IF NOT EXISTS public.lb_template_categories (
    id text PRIMARY KEY, name_zh text NOT NULL, name_en text NOT NULL,
    sort integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  // The built-in templates' categories, so the gallery filters both kinds with one list.
  `INSERT INTO public.lb_template_categories(id,name_zh,name_en,sort) VALUES
    ('games','游戏与互动','Games & Interactive',10),('operations','运营管理','Operations',20),('commerce','商品与销售','Commerce',30),
    ('finance','财务','Finance',40),('customers','客户与服务','Customers & Service',50),
    ('teamwork','团队协作','Teamwork',60)
    ON CONFLICT (id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS public.lb_community_templates (
    id text PRIMARY KEY,
    owner_id text NOT NULL,
    project_id text REFERENCES public.lb_projects(id) ON DELETE SET NULL,
    app_id text NOT NULL UNIQUE,
    name text NOT NULL, description text NOT NULL DEFAULT '',
    category_id text REFERENCES public.lb_template_categories(id) ON DELETE SET NULL,
    tags text[] NOT NULL DEFAULT '{}',
    ir jsonb NOT NULL, files jsonb NOT NULL, cover_url text,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    featured boolean NOT NULL DEFAULT false,
    review_note text, reviewed_by text, reviewed_at timestamptz,
    uses integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Templates published before their app's first cover existed. Same path as storage/keys.ts thumbKey.
  `UPDATE public.lb_community_templates t
    SET cover_url = '/api/files/public/thumb/' || a.project_id || '/' || a.id || '.png'
    FROM public.lb_apps a
    WHERE a.id = t.app_id AND t.cover_url IS NULL AND a.cover_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS lb_community_templates_listing ON public.lb_community_templates(status, featured DESC, uses DESC)`,
  `CREATE TABLE IF NOT EXISTS public.lb_community_template_uses (
    user_id text NOT NULL, request_id text NOT NULL,
    template_id text NOT NULL REFERENCES public.lb_community_templates(id) ON DELETE CASCADE,
    project_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id, request_id)
  )`,
  // Gallery order and numbers, for built-in and community templates alike. A key is a built-in's id
  // or `c:<id>` for a community one — the same key the gallery gives its cards. No position means
  // after every positioned one, in the gallery's own order.
  `CREATE TABLE IF NOT EXISTS public.lb_template_positions (
    template_key text PRIMARY KEY, position integer NOT NULL
  )`,
  // Daily counters rather than one row per visit: the admin page wants totals and a recent window,
  // not who looked. Created once with what installs already happened, so the counts start honest;
  // a built-in project deleted since then is gone from that history.
  `DO $$ BEGIN
    IF to_regclass('public.lb_template_daily') IS NULL THEN
      CREATE TABLE public.lb_template_daily (
        template_key text NOT NULL, day date NOT NULL,
        views integer NOT NULL DEFAULT 0, installs integer NOT NULL DEFAULT 0,
        PRIMARY KEY(template_key, day)
      );
      INSERT INTO public.lb_template_daily(template_key, day, installs)
        SELECT key, day, sum(n) FROM (
          SELECT 'c:' || template_id AS key, created_at::date AS day, count(*) AS n FROM public.lb_community_template_uses GROUP BY 1, 2
          UNION ALL
          SELECT i.template_id, p.created_at::date, count(*) FROM public.lb_template_instances i
            JOIN public.lb_projects p ON p.id = i.project_id WHERE NOT i.demo GROUP BY 1, 2
        ) x GROUP BY 1, 2;
    END IF;
  END $$`,
]
