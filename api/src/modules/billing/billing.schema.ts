export const billingSchema = [
  `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS stripe_account_id text`,
  `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS stripe_mode text`,
  `CREATE TABLE IF NOT EXISTS public.lb_billing_sync (
    user_id text PRIMARY KEY REFERENCES public."user"(id) ON DELETE CASCADE,
    version bigint NOT NULL DEFAULT 1, attempts int NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_billing_control (
    id integer PRIMARY KEY CHECK(id=1), paused boolean NOT NULL DEFAULT false
  )`,
  `INSERT INTO public.lb_billing_control(id) VALUES(1) ON CONFLICT DO NOTHING`,
  `ALTER TABLE public.lb_billing_control ADD COLUMN IF NOT EXISTS storage_ready boolean NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS public.lb_billing_migrations (
    user_id text NOT NULL REFERENCES public."user"(id), migration text NOT NULL,
    before_state jsonb NOT NULL, report jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(user_id,migration)
  )`,
  `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS stripe_paid_until timestamptz`,
  `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS stripe_paid_start timestamptz`,
  `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS stripe_status text`,
  `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS stripe_interval text`,
  `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS stripe_cancel_at_period_end boolean NOT NULL DEFAULT false`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lb_stripe_customer ON public."user"(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS public.lb_billing_events (
    id text PRIMARY KEY, type text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_checkout_sessions (
    id text PRIMARY KEY, user_id text NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    kind text NOT NULL, target text NOT NULL, yearly boolean NOT NULL DEFAULT false,
    status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS lb_checkout_user ON public.lb_checkout_sessions(user_id, created_at DESC)`,
]
