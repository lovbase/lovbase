# Stripe Live cutover

Prices: Pro $25/month or $240/year; credit packs 200/$10, 1,000/$45, 5,000/$200. Business remains registration only. Tax and initiation of money refunds are handled manually; Stripe Tax is not enabled. Refund results automatically reconcile credits and Pro after the refund worker release and webhook event list are deployed; see [refund operations](stripe-refunds.md).

## Release hold

Repository Actions variable `PRODUCTION_DEPLOY_PAUSED=true` prevents the production deployment job while still running full checks on master. Web, Worker and Cloudflare sandbox otherwise deploy serially from one checked commit. Remove the hold only when Railway is available and the operator is ready for cutover. Check existing master runs before dispatching another deployment.

## Private configuration

1. Set `STRIPE_MODE=disabled` explicitly on Web and Worker before deploying. Disabled mode closes purchase entry points and rejects webhooks. Self-hosted installations can stay disabled without Stripe credentials.
2. Inject the Live secret key through the platform. Never commit it, put it in build arguments or VITE variables, or paste it in chat/shell history. Local `app/.env` stays Test; `bun run stripe:setup` writes the Test mode and account ID there.
3. Safely read the current account ID from Stripe `/v1/account` and set `STRIPE_ACCOUNT_ID`. In a trusted operator environment run `bun run stripe:setup:live /private/path/live-catalog.json` with `STRIPE_SECRET_KEY`, `STRIPE_ACCOUNT_ID`, `BETTER_AUTH_URL=https://lovbase.dev` injected. It creates no charges. The mode-0600 output must be outside the repository; it contains price IDs, Portal ID and the one-time webhook secret, but excludes the API key. Keep it secure: Stripe cannot recover an existing endpoint secret.
4. Setup reuses stable product IDs, price lookup keys, tagged Portal and webhook URL. Conflicting resources fail verification rather than being silently changed. Review partial results before retrying. If the endpoint already exists, supply its secret securely from Dashboard.
5. Upload the output configuration to Web and Worker, retaining `STRIPE_MODE=disabled`. A customer is bound to the verified Stripe account and mode; changing keys cannot repurpose old customer associations.
6. Run `bun run stripe:preflight` with the intended enabled mode in the command environment. This is read-only: activation, five product/price modes and USD amounts, intervals, Portal period-end cancellation without plan switching, exact webhook URL/events and SDK API version must pass. It cannot prove the signing secret matches the endpoint; verify a real signed delivery and 2xx acknowledgement after activation too.

The API version and events live in `stripe-contract.ts`. Review them whenever upgrading Stripe. Local CLI forwarding uses `--latest` because the installed CLI has no pinned-version listener flag; inspect forwarded `api_version` after upgrades, or use a hosted Test endpoint pinned to the contract version.

## Backup, maintenance and migration

Production currently runs PostgreSQL 18.6. Use `pg_dump` 18 or newer for its backup. The runtime image uses client 18, and CI verifies SQL restore with PostgreSQL 17 and 18.

1. Make a full custom-format backup in a private mode-0600 file. Verify `pg_restore --list` and restore a copy into an isolated database before modifying production billing. Retain the verified rollback artifact.
2. Once the closed-payment release is healthy, set `BILLING_MAINTENANCE=true` on both services and `UPDATE public.lb_billing_control SET paused=true WHERE id=1`. The persistent flag stops generation, purchases and wallet grants. Let active jobs/model settlement drain; migration refuses running or unsettled work. Growing writes remain gated while inventory can proceed.
3. Run `bun run stripe:migrate preview /private/path/report.json` with production `DATABASE_URL`. When associations exist, also inject the original `TEST_STRIPE_SECRET_KEY` and `TEST_STRIPE_ACCOUNT_ID`. The script fetches customer metadata, subscriptions and every Checkout from that Test account and verifies mode/ownership. ID prefixes or Live lookup failures are insufficient evidence. No associations/purchase grants produces an explicit no-op report without a Test key.
4. Review all discrepancies. Run `BILLING_BACKUP_FILE=/private/path/verified.dump bun run stripe:migrate apply /private/path/report.json`. Any blocked account prevents application. The file must be the already verified backup; existence/size checking in the script is not a restore test. Each account is transactional, fingerprinted against preview, archived and marked idempotently. Repeat application skips completed accounts. Test-backed Pro becomes Free; test associations and paid coverage clear. Historical ledgers, projects and publications remain. Independent manual plans remain.
5. Wallet replay consumes Test credits first, preserving remaining manual gifts. New charges record exact wallet debit. Missing historical debit evidence, ambiguous timestamps or balance mismatches block migration. An entirely untouched wallet can be proven by its positive grants and current balance; otherwise resolve history before applying. Negative admin adjustments consume test balance first, then manual balance. Do not invent missing history.
6. Verify `lb_billing_sync` is empty, direct roles are reconciled/disconnected where required, and queued priorities match effective plans. Verify complete object/source/database inventory and `lb_billing_control.storage_ready=true` before reopening writes. The first production inventory gates mutations; failed listings keep the gate closed. Confirm bucket configuration too.
7. Set `paused=false`, then `BILLING_MAINTENANCE=false` on both services. Keep `STRIPE_MODE=disabled` until the Live checks pass. Rollback before activation uses archived before-state plus the verified backup; never blindly overwrite later changes or replay credit grants.

## Test and enable

Regress hosted Test monthly/yearly/pack payments, declined cards, cancellation returns/scroll, duplicate/out-of-order events, renewals and cancellation at period end. Fixture tests alone do not establish hosted delivery.

After preflight and maintenance verification, set `STRIPE_MODE=live` consistently on both services. Verify Live Checkout amounts, return paths, Portal cancellation policy, signed delivery and server-confirmed rights. Never use test cards in Live.

The owner performs one real 200-credit/$10 purchase. Verify exactly one grant, receipt and balance, then refund in Stripe Dashboard. Verify the automatic reversal/debt ledger and durable action completion in Admin; do not also subtract the same credits manually. Record refund ID, purchase reference, USD amount and consumed/unconsumed credits.

## Manual operations

Successful refunds automatically revoke unused purchased credits and record consumed refunded credits as separate debt. Full Pro invoice refunds revoke local Pro and durably cancel the corresponding Stripe subscription; partial Pro refunds keep coverage until cumulative full refund. Refund and cancellation remain distinct Stripe operations, so verify both the local action state and remote subscription. Open/won disputes require review; lost Pro disputes revoke rights without inventing refund amounts. Historical unassociated purchases require manual review. See [refund operations](stripe-refunds.md).

Enable Stripe notifications for disputes and webhook failures, assign an operator, and inspect Dashboard regularly. Disputes do not automatically reverse the ledger; preserve evidence and record manual rights/credit decisions. Confirm applicable tax obligations before serving each jurisdiction. Monitor pending entitlement sync attempts, expired paid coverage and Stripe/local purchase reconciliation after launch.
