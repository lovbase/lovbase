export const feedbackSchema = [
  `CREATE TABLE IF NOT EXISTS public.lb_feedback (
    id text PRIMARY KEY,
    user_id text REFERENCES public."user"(id) ON DELETE SET NULL,
    project_id text REFERENCES public.lb_projects(id) ON DELETE SET NULL,
    kind text NOT NULL CHECK (kind IN ('suggestion','bug','other')),
    message text NOT NULL,
    page text NOT NULL,
    status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','resolved')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS lb_feedback_created ON public.lb_feedback(created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS lb_feedback_user ON public.lb_feedback(user_id, created_at DESC)`,
  // Small, bounded screenshots stay with their report, including on installations without a bucket.
  `CREATE TABLE IF NOT EXISTS public.lb_feedback_images (
    feedback_id text NOT NULL REFERENCES public.lb_feedback(id) ON DELETE CASCADE,
    position integer NOT NULL, name text NOT NULL, content_type text NOT NULL, bytes bytea NOT NULL,
    PRIMARY KEY (feedback_id, position)
  )`,
]
