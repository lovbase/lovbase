/** Additive migrations, also exercised against PostgreSQL in the skill tests. */
export const skillsSchema = [
  `CREATE TABLE IF NOT EXISTS public.lb_project_skills (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    name text NOT NULL, description text NOT NULL, body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(project_id, name)
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_project_skill_preferences (
    user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    project_id text NOT NULL REFERENCES public.lb_projects(id) ON DELETE CASCADE,
    enabled_ids text[] NOT NULL,
    PRIMARY KEY(user_id, project_id)
  )`,
]
