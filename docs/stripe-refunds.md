# Refund reversals and Pro revocation

Stripe Dashboard initiates money refunds. The application consumes successful refund results; it never issues money refunds itself. Full Pro invoice refunds cancel the corresponding Stripe subscription immediately, revoke local paid coverage and reconcile database access/queue priority. Partial Pro refunds preserve the full term until cumulative successful refunds equal the invoice payment. An old subscription refund cannot revoke a replacement subscription or an independently granted Business plan.

## Wallet invariants

- Original grants and usage remain immutable audit facts. `lb_wallet_lots` tracks remaining purchased/admin/opening credits, and `lb_wallet_spends` attributes wallet consumption. Plan allowance is spent first, then purchased lots FIFO, then protected gifts/opening lots.
- Each charge is associated by verified customer, account, mode, PaymentIntent, charge and original USD amount. Cumulative successful refunds determine `floor(granted × refunded / paid)`. The cumulative reversal target is monotonic; duplicate, concurrent and out-of-order events only apply the missing delta.
- Reversals remove available credits from the original purchase only. Used credits create separate `lb_credit_debt_entries`; wallet balances stay nonnegative. Existing purchased lots are frozen while debt remains, but gifts and plan allowance remain available. New purchased credits settle debt before becoming spendable. Refund of a debt-settling purchase reinstates the corresponding debt.
- Never convert a refund into a generic negative admin grant. Admin debt forgiveness appends a separate actor/reason/idempotency-key entry. The original grant and usage are not rewritten.
- The opening wallet is captured lazily under the same user lock on first mutation. Historical purchases without verified provenance/lot history are listed for manual association and never automatically attributed to gifts or refunded. No guessed historical replay occurs. Review the historical list before enabling the feature for existing purchasers.

## Delivery and operations

1. Back up the database. Deploy the same Web/Worker revision. The idempotent startup migration adds tables/columns after the original grant table; no old balances are changed. Verify the schema is ready before restoring purchases/generation during a maintenance rollout.
2. Run `bun run stripe:sync-webhook` with the environment securely injected for a read-only event diff. After the release is healthy, run `bun run stripe:sync-webhook --apply`, then `bun run stripe:preflight`. The signing secret is unchanged. Both Test and Live endpoints need `charge.refunded`, `refund.created`, `refund.updated`, `charge.dispute.created`, `charge.dispute.closed` in addition to existing checkout/subscription/invoice events. Never enable events against the old worker release.
3. Verified refund webhooks atomically write an inbox event and durable `lb_billing_actions`; they can acknowledge without a Stripe API call. After commit, the webhook wakes the existing maintenance queue for prompt processing. Startup and minute reconciliation provide a durable fallback if Redis is unavailable; revocation then takes up to one maintenance interval plus network latency. Local facts commit before external cancellation/access/queue actions.
4. Actions use a five-minute lease/version, skip-locked claiming and exponential retry (capped at one hour). After 20 failed attempts they enter `manual_review`. Review pending/manual actions in Admin → Refunds and credit reversals; confirm a reason before retrying. Cancellation, access and priority actions are individually retryable. Investigate pending actions if the worker is unavailable; do not mark cancellation complete while Stripe still reports an active subscription.
5. Pro revocation inserts a subscription-specific permanent fence. Subscription/invoice refresh excludes fenced subscriptions before applying the paid-period fallback. A new legitimate paid subscription can grant Pro again. Projects, source, data and published pages remain intact; existing Free limits apply to new writes/creates/publication.
6. Disputes always appear as review items. Open/won disputes do not change entitlement. A confirmed **lost** dispute revokes the associated Pro subscription and cancels renewal. Disputes never fabricate a refund amount; pack chargeback accounting remains an explicit review action. A later true refund is independently reconciled.

## Audit/review

Admin lists original amount, refund amount/cumulative ratio, purchased/revoked/used/debt credits, refund and charge IDs, timestamp, revoked subscription and durable action state. Outstanding debt and historical unassociated purchases are listed separately. Review and retry requires explicit confirmation and stores actor/reason; debt forgiveness appends its own ledger entry. Retained financial records are not cascaded away when an application account is removed.

Before a manual historical correction, verify the Stripe account/mode, receipt and complete local grant/usage history. Use the existing admin credit adjustment for a separately justified wallet correction, or the explicit debt adjustment; document why. A retry does not guess a missing association and does not rewrite the original grant. Unsupported split invoice payments/currency or ambiguous associations remain in review.

## Validation

`bun test api/tests/billing.test.ts api/tests/refunds.test.ts` runs without external Stripe credentials (PGlite). Set `BILLING_TEST_DATABASE_URL` to a disposable PostgreSQL 17 database with CREATE DATABASE permission to run the same refund suite against real row/advisory locks; it creates and removes its own isolated test database. CI supplies this variable. The suite covers cumulative/duplicate/concurrent refunds, gift protection, debt settlement/refund, late paid Checkout, API failures/retries, annual/monthly Pro, cancellation failure, old-event fences, replacement subscriptions, disputes and historical review.

Before production rollout, run `REFUND_TEST_DATABASE_URL=postgres://…@localhost:5432/disposable bun run stripe:test-refunds` for the opt-in Stripe Test regression. It reads Test configuration from `app/.env` (injected environment wins), requires an explicit local database, creates/removes its own isolated database and uses only Stripe's Test token. It exercises real PaymentIntent/refund APIs, gifts/debt settlement, monthly/annual subscriptions and remote cancellation, then deletes its test customer. No Live key is accepted. Finally verify the dashboard-issued refund of the owner's real small pack after deployment. Never use test cards in Live mode. Confirm the wallet/reversal/debt ledger and Stripe subscription state, rather than treating webhook delivery success alone as completion.

### Executed locally on 2026-10-23

- Full repository suite with PostgreSQL 17 entitlement/template/refund integration enabled: **387 passed, 15 skipped, 0 failed**. The skipped tests require an object-storage endpoint; no refund test was skipped in this run.
- Refund suite on PostgreSQL 17: **21 passed**, including an actual read-only login/session revocation and retained project data.
- Real Stripe Test API regression: passed for partial/cumulative pack refunds, duplicate events, protected gifts, debt settlement, monthly/annual subscription refund/cancellation and stale-event fencing. Regression customers/subscriptions and isolated databases were cleaned up.
- API/app type checks, lint and production builds passed. Production was not deployed, Live endpoint events were not changed, and hosted Live webhook delivery was not claimed as verified.
