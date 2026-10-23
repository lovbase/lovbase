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

/** Runs after the original grants and usage tables exist. Existing balances are not reinterpreted. */
export const refundWalletSchema = [
  `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS credit_debt integer NOT NULL DEFAULT 0 CHECK(credit_debt>=0)`,
  `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS paid_credit_locked boolean NOT NULL DEFAULT false`,
  `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS wallet_lots_ready boolean NOT NULL DEFAULT false`,
  `ALTER TABLE public."user" ADD COLUMN IF NOT EXISTS stripe_entitlement_revoked_at timestamptz`,
  `ALTER TABLE public.lb_credit_grants ADD COLUMN IF NOT EXISTS stripe_payment_intent_id text`,
  `ALTER TABLE public.lb_credit_grants ADD COLUMN IF NOT EXISTS stripe_charge_id text`,
  `ALTER TABLE public.lb_credit_grants ADD COLUMN IF NOT EXISTS stripe_account_id text`,
  `ALTER TABLE public.lb_credit_grants ADD COLUMN IF NOT EXISTS stripe_mode text`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lb_grant_charge ON public.lb_credit_grants(stripe_charge_id) WHERE stripe_charge_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lb_grant_pi ON public.lb_credit_grants(stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS public.lb_wallet_lots (
    id bigserial PRIMARY KEY, user_id text NOT NULL,
    grant_id bigint UNIQUE REFERENCES public.lb_credit_grants(id), source text NOT NULL,
    credits integer NOT NULL CHECK(credits>=0), remaining integer NOT NULL CHECK(remaining>=0),
    consumed integer NOT NULL DEFAULT 0 CHECK(consumed>=0), revoked integer NOT NULL DEFAULT 0 CHECK(revoked>=0),
    debt_settled integer NOT NULL DEFAULT 0 CHECK(debt_settled>=0), created_at timestamptz NOT NULL DEFAULT now(),
    CHECK(credits=remaining+consumed+revoked+debt_settled)
  )`,
  `CREATE INDEX IF NOT EXISTS lb_wallet_fifo ON public.lb_wallet_lots(user_id,created_at,id)`,
  `CREATE TABLE IF NOT EXISTS public.lb_wallet_spends (
    entry_key text NOT NULL, lot_id bigint NOT NULL REFERENCES public.lb_wallet_lots(id),
    credits integer NOT NULL CHECK(credits>0), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(entry_key,lot_id)
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_billing_refunds (
    stripe_refund_id text PRIMARY KEY, stripe_charge_id text NOT NULL, stripe_payment_intent_id text,
    stripe_account_id text NOT NULL, stripe_mode text NOT NULL, user_id text,
    amount_cents integer NOT NULL, original_amount_cents integer NOT NULL,
    cumulative_refunded_cents integer NOT NULL, status text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_credit_reversals (
    id bigserial PRIMARY KEY, user_id text NOT NULL,
    refund_id text NOT NULL REFERENCES public.lb_billing_refunds(stripe_refund_id),
    grant_id bigint NOT NULL REFERENCES public.lb_credit_grants(id),
    granted_credits integer NOT NULL, target_credits integer NOT NULL,
    revoked_unused_credits integer NOT NULL CHECK(revoked_unused_credits>=0),
    used_credits integer NOT NULL CHECK(used_credits>=0), debt_credits integer NOT NULL CHECK(debt_credits>=0),
    status text NOT NULL DEFAULT 'complete', created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(grant_id,target_credits)
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_credit_debt_entries (
    entry_key text PRIMARY KEY, user_id text NOT NULL, delta integer NOT NULL,
    reversal_id bigint REFERENCES public.lb_credit_reversals(id), grant_id bigint REFERENCES public.lb_credit_grants(id),
    actor text, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_subscription_revocations (
    subscription_id text PRIMARY KEY, user_id text NOT NULL,
    invoice_id text, charge_id text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS public.lb_billing_actions (
    action_key text PRIMARY KEY, kind text NOT NULL, user_id text,
    payload jsonb NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
    version integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
    review_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS lb_billing_action_pending ON public.lb_billing_actions(status,available_at)`,
  `CREATE TABLE IF NOT EXISTS public.lb_billing_admin_audit (
    id bigserial PRIMARY KEY, action_key text NOT NULL, actor text NOT NULL, operation text NOT NULL,
    reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
  )`,
]
