export const billingSchema = [
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
