# Architecture

How the app is put together: the parts, the code layout, the purchase-to-activation data flow, the security
controls, the scheduled jobs and the deployment. Written for the first test-mode deployment (2026-10-07). The binding
rules are in [`decisions.md`](decisions.md); this page explains how the code implements them. Related:
[`api.md`](api.md) (every endpoint), [`security.md`](security.md), [`scaling.md`](scaling.md),
[`performance.md`](performance.md), [`../deploy/README.md`](../deploy/README.md). The handoff's own design-time
architecture is `../design_handoff_axiomatic/docs/architecture.md`.

## System overview

One Next.js 15 application (App Router, TypeScript, Node.js runtime) serves four areas from one codebase and one
database: the **storefront** (catalog, product pages, cart, docs, legal), the **purchase journey** (checkout, hosted
payment, order page), the **customer portal** (`/account`) and the **admin console** (`/admin`), plus the **device
API** that installed apps call.

```
Browsers ---------+                                   +--> PostgreSQL (all data; sessions; outbox)
Desktop/Android   |                                   |
apps (device API) +--https--> Nginx (TLS) --> Next.js +--> Redis (rate limits, shared by all processes)
Razorpay webhooks-+                          (PM2,    +--> Razorpay REST API (orders, payments, refunds)
                                              next    +--> S3-compatible bucket (installers, attachments;
Scheduler (cron) --http 127.0.0.1-----------> start)  |    browsers upload and download with presigned URLs)
                                                      +--> SMTP provider (emails)
```

- **Stateless app processes.** Sessions, orders, rate limits and the email queue live in PostgreSQL or Redis, so more processes (PM2 cluster mode) or servers can be added behind the proxy.
- **The database is the source of truth.** Prisma 7 with the `pg` adapter (`lib/db.ts`); each process has a bounded
  pool (`DATABASE_POOL_MAX` 10, waits and statements capped at 5 s) and answers 503 `unavailable` instead of hanging
  when the database is saturated.
- **No file passes through the app.** Installers and ticket attachments go straight between the browser and the
  private bucket through presigned URLs (at most 10 minutes); the app only signs and checks.
- **Payments are confirmed server to server.** The browser never marks an order paid: only the signed webhook (or
  reconciliation asking the provider) does, and only that path issues paid licenses.

## Code layout

| Folder | Contents |
|---|---|
| `app/(store)` | Storefront pages: `/`, `/software` (catalog) and `/software/[slug]`, `/pricing`, `/compare`, `/cart`, `/contact`, `/about`, `/support`, `/docs/[slug]`, `/legal/[doc]`, `/orders/[id]` (order page) |
| `app/(checkout)`, `app/(auth)`, `app/(staff-auth)` | `/checkout`; `/sign-in`, `/register`, `/verify`, `/forgot`, `/reset`, `/invite`; `/staff-invite` |
| `app/account`, `app/admin` | Customer portal (14 pages) and admin console (17 modules); each page checks its own access |
| `app/api` | Route handlers (see [`api.md`](api.md)); `app/dev` development-only pages |
| `components/` | `ui` (shadcn/Radix primitives), `store`, `checkout`, `auth`, `account`, `admin`, `data-table` (lists that become cards on phones), `icons` (generated Material Symbols registry), `seo` |
| `lib/` | Server and shared logic (next table); `lib/rbac.ts` is the only source of permissions |
| `content/` | Code-managed copy: home, pricing, about, support, docs guides, legal documents, screenshot panels |
| `prisma/` | `schema.prisma`, migrations, the development seed and `seed-data/bootstrap.ts` (production catalog and first Owner) |
| `middleware.ts`, `instrumentation.ts`, `instrumentation-client.ts` | Edge middleware (strict CSP, optimistic redirects, `/api/dev` 404); server start-up (env check, Redis store); browser start-up (Zod without eval) |
| `scripts/`, `deploy/`, `tests/` | Dev and check tools; server scripts; unit, DB and end-to-end tests |

### Modules in `lib/`

| Module | Responsibility |
|---|---|
| `env.ts`, `config.ts` | Validated environment (refuses placeholders, and in production the mock provider, local storage, console email, fixture catalog, http `APP_URL`, missing Redis); typed `SiteSetting` reader with defaults |
| `db.ts`, `db-errors.ts`, `counters.ts` | Prisma client and pool bounds; mapping of pool and timeout errors to 503; gap-free ids and document numbers (`AX-` orders, `LIC-` licenses, `T-` tickets, invoice and credit-note series) from one atomic upsert |
| `http.ts`, `log.ts`, `audit.ts` | Route wrapper, error envelope, capped body reader, client IP from `TRUSTED_PROXY_HOPS`; redacting logger; append-only audit rows |
| `auth/` | argon2id passwords, sessions, cookies, CSRF, rate limits (Postgres buckets or Redis Lua scripts), trusted devices, guards (`requireUser`, `requireAccountRole`, `requireStaff`), and the flows (register, sign-in, two-step, verify, reset, claim guest orders) |
| `rbac.ts` | Staff permissions, team permissions, admin modules, destructive-action rules |
| `validation/` | Zod schemas: GSTIN and states, billing, checkout, auth, portal, tickets, activation |
| `pricing.ts`, `money.ts`, `dates.ts` | `quote()`, coupons, GST split and largest-remainder allocation (pure); paise formatting; IST dates, financial years, calendar arithmetic |
| `storefront/`, `catalog/`, `seo/`, `cart/`, `compare/` | Cached catalog reads (`unstable_cache`, tags `catalog`, `faqs`, `settings`), product content schema, metadata and JSON-LD; the browser cart and compare stores |
| `checkout/`, `orders/`, `invoice/` | Quote, order creation, payment return, cancel, retry, coupon holds; order access and order-link tokens, status with one-time key delivery; invoice model and PDF |
| `payments/` | Provider interface, Razorpay adapter (REST, no SDK), mock provider, webhook processing, reconciliation |
| `licensing/` | Keys (generation, HMAC, AES-GCM), terms, status, entitlement, issue, fulfilment, device limits, activation tokens and the device API services, portal license reads |
| `downloads/`, `software/`, `storage/` | Entitlement checks and presigned links; the portal software view; S3 and local storage drivers |
| `email/` | Templates and layout, outbox (queued in the business transaction), direct sending for codes and invitations, console and SMTP transports, the dev mailbox |
| `portal/` | Portal context and services: overview, team and invitations, tickets and uploads, billing, notifications, activity, search, export, trials |
| `admin/` | `adminRoute()`, the route registry, destructive-action helper, list queries, CSV exports, and one folder per module (catalog, orders and refunds, customers, licenses, renewals, coupons, content, templates, leads, tickets, staff, audit, settings, overview, reports) |
| `jobs/` | Maintenance job: retention cutoffs, bounded batches, tasks |
| `security/` | Content-Security-Policy builder, security headers, the hashed inline scripts |
| `design/tokens.ts` | Design tokens (the single source for Tailwind and the shadcn aliases) |

## Rendering and caching

- **Storefront**: home, product, pricing, docs, legal, about and support pages are prerendered and revalidated
  (ISR, 300 s); `/cart` is a static shell filled in the browser. The catalog data layer (`lib/storefront/data.ts`) caches with tags, and every admin catalog, content
  or settings write calls `revalidateTag()`, so changes show at once. `/software`, `/compare` and `/contact` render per
  request. A production build therefore needs the database (`CATALOG_SOURCE=db`).
- **Portal, admin, checkout, order and auth pages** render per request (they read the session) and get the strict
  nonce-based CSP from `middleware.ts`.
- **Prices** render in both forms (excluding and including GST); `<html data-price>` picks one with CSS, set before
  paint by a tiny hashed inline script, so static pages need no per-visitor rendering.
- **The cart** is browser state (`localStorage`); the server re-prices it at every quote and at order creation.

## Data model

PostgreSQL through Prisma (`prisma/schema.prisma`, 37 models). The main groups:

| Group | Tables |
|---|---|
| People and access | `User` (customers and staff, `kind`; staff role and status; `securityEpoch`), `Session`, `AuthToken` (codes, reset and invitation links, hashes only), `BusinessAccount`, `AccountMember` (team role), `Location`, `RateLimitBucket` |
| Catalog | `Category`, `Product`, `Plan` (type: TRIAL, ONE_TIME, ANNUAL, SUBSCRIPTION, DEVICE_ADDON, MAINTENANCE), `Release`, `ReleaseFile`, `Faq`, `SiteSetting`, `NotificationTemplate` |
| Commerce | `Order` (billing and price snapshot), `OrderItem` (kind NEW, RENEWAL, ADDON, UPGRADE; `termsBefore`/`termsAfter`), `Payment`, `Refund`, `Invoice` (seller snapshot), `Coupon`, `CouponRedemption`, `WebhookEvent` (idempotency key: provider + event id), `WebhookDelivery`, `Counter` |
| Licensing | `License` (key hash, ciphertext, last 4; terms; nullable `accountId` for guest orders), `DeviceActivation`, `LicenseEvent`, `DownloadEvent` |
| Support and messaging | `SupportTicket`, `TicketMessage`, `Upload`, `Notification`, `OutboxEmail`, `Lead` |
| Records | `AuditLog` (append-only), `AccountActivity` (customer-facing log) |

## Purchase to activation

```
Browser                      App                                         Razorpay           Installed app
 cart in localStorage
 POST /api/checkout/quote --> re-price from the database (display only)
 POST /api/checkout/orders -> re-price, order id, provider order -------> create order
                              Order AWAITING_PAYMENT + Payment CREATED
 <- checkout options -------
 Checkout.js modal ------------------------------------------------------> customer pays
 POST .../return ----------> signature ok: attempt AUTHORIZED,
                              order CONFIRMING (never PAID here)
 GET /api/orders/:id/status every 2 s           <---- webhook payment.captured (signed)
                              verify HMAC, lock order, record event once,
                              PAID, fulfil, invoice number, emails queued
 <- PAID + full key, once --
 POST .../downloads -------> entitlement check, presigned bucket URL
                                                <------------------------------------ POST /api/v1/licenses/activate
                              lock license, take a device slot,
                              Ed25519 activation token ----------------------------> token stored, checked offline
                                                <------------------------------------ POST /validate (start-up, daily)
```

1. **Cart and quote.** The cart is `{ planId, qty, kind, targetLicenseId }` lines in `localStorage`.
   `POST /api/checkout/quote` prices it with `quote()` (`lib/pricing.ts`) from database prices, coupons and the GST
   rule, for display only; refused lines come back as `issues`.
2. **Order creation** (`lib/checkout/create-order.ts`). The server prices the cart again and refuses anything that
   changed (`cart_invalid`, or the coupon on `couponCode`). The order id comes from its own short transaction; the
   provider order is created **outside** any transaction (a provider failure stores nothing, 502); then one
   transaction locks and re-checks the coupon, optionally creates the customer and account ("Create an account"),
   and inserts `Order` (AWAITING_PAYMENT, billing and price snapshot, per-line discount and tax), its items, the
   accepted terms version and `Payment` (CREATED). An order never exists without a payment attempt.
3. **Payment.** The browser opens Razorpay Checkout.js (`components/checkout/hosted-checkout.ts`). On success it posts
   the signed result to `/api/checkout/orders/:id/return`, which only moves the order to CONFIRMING. Closing the modal
   cancels the attempt; "Try again" opens a new attempt for the same order. In development the mock provider's
   `/dev/mock-checkout` page plays the provider and sends real signed webhooks.
4. **Webhook** (`app/api/webhooks/payments/[provider]`, `lib/payments/webhook.ts`). The raw body's HMAC is checked;
   the event is normalised by the adapter. One transaction then: finds the payment by provider order id, locks the
   order row (`SELECT ... FOR UPDATE`), inserts `WebhookEvent(provider, eventId)` with `ON CONFLICT DO NOTHING` (a
   duplicate or replay changes nothing), checks amount, currency and provider order, and marks Payment CAPTURED and
   Order PAID (`paidAt` = the event time).
5. **Fulfilment** (`lib/licensing/fulfil.ts`), in the same transaction: NEW items issue licenses through
   `issueLicense()` (the only way any license is created: paid orders, trials and staff manual issue); RENEWAL,
   MAINTENANCE, ADDON and UPGRADE items change the target license, storing its terms before and after for a later
   refund; a lowered device limit deactivates the least recently seen devices. Then the invoice number
   (`AXS/<FY>/<n>`, gap-free), the invoice with a seller snapshot, the coupon redemption, audit, account activity,
   notifications and the outbox emails (order confirmation, license issued; never a key). If fulfilment throws,
   everything rolls back and a second transaction marks the order REVIEW with the reason, so the provider still
   gets a 200 and staff resolve it.
6. **Safety nets.** Reconciliation (`/api/cron/reconcile`, every 10 minutes) asks Razorpay about attempts whose
   webhook never came and feeds the answer through the same handler (event id `reconcile:<paymentId>`). Transient
   database errors answer 500 so Razorpay redelivers. Staff can replay a stored event (idempotent).
7. **Key delivery.** The order page polls `GET /api/orders/:id/status`. The first response to the purchaser after
   payment carries each full key and sets `License.keyDeliveredAt` in a conditional update, so the key is shown once;
   afterwards it is masked and revealing it needs an account and the password (`POST /api/account/licenses/:id/reveal`).
   Keys are stored only as HMAC (lookup), AES-256-GCM ciphertext (reveal) and the last 4 characters.
8. **Guest claim.** A guest order belongs to no account (`accountId` null). When the buyer registers or signs in with
   a verified email, the orders with that email and their licenses move to the account the user created and owns.
9. **Download.** `POST /api/account/downloads` (or the order page's `/api/orders/:id/downloads`) checks the
   entitlement (status, expiry, updates window against the release date, stable channel) and returns a presigned
   bucket URL valid for at most 10 minutes, recording a `DownloadEvent`.
10. **Activation** (`lib/licensing/activation.ts`). The app sends the key, its fingerprint and `X-App-Id`. The server
    finds the license by the key's HMAC, checks status and product, locks the license row so concurrent activations
    cannot exceed the device limit, records the device and returns an Ed25519 token (`{ lic, fp, prod }`, valid for 7
    days or until the license ends). The app verifies the token offline with the embedded public key and calls
    `/validate` at start-up and daily: one signature check and one indexed read, `lastSeenAt` written at most every
    12 hours, a fresh token back. `/deactivate` frees the slot.

### Refunds
Finance or the Owner refunds from the order drawer (`POST /api/admin/orders/:id/refund`, reason and typed order id).
The provider refund is requested first, inside a transaction that holds the order lock; then the same transaction
creates `Refund` (PENDING) with a credit-note number (`AXC/<FY>/<n>`), revokes the licenses the order issued, restores
the stored terms of licenses it renewed, upgraded or added devices to (or flags the order for review when the license
changed since), notifies the customer (`refund_issued`) and writes one audit row. Razorpay's `refund.processed` webhook then
marks the refund PROCESSED and the order REFUNDED; `refund.failed` marks it FAILED and the order In review.
Reconciliation re-checks refunds still pending after a day. A duplicate captured payment is refunded on its own.

### Other flows
- **Trials**: `POST /api/account/trials` (verified email, one per product per account) issues a TRIAL license through
  `issueLicense()`; buying from the trial is an UPGRADE of the same license.
- **Renewals**: the portal's Renew tab adds RENEWAL (maintenance included), ADDON or UPGRADE lines with the target
  license to the cart; they are paid like any order. Renewals are manual (no mandates). Reminders: the daily renewals job, and
  "Send reminder now" in Admin > Renewals.
- **Releases**: staff create a draft, upload installers straight to the bucket (the server checks the size and
  computes SHA-256), then publish; entitled accounts get an in-app notification and the `release_available` email,
  sent after the response.
- **Tickets**: customers and staff exchange messages with attachments (presigned upload, confirm, attach); staff
  notes never reach the portal; a resolved ticket closes 14 days later.
- **Emails**: business emails are rendered and queued in `OutboxEmail` inside the transaction that causes them, sent
  right after the commit and retried by the emails job (at least once, deduplicated by key). Codes, reset links and
  invitation links are sent directly and never stored.

## Security controls

Full threat model and rationale: [`security.md`](security.md).

| Area | Control | Where |
|---|---|---|
| Passwords and sign-in | argon2id; 5 failures per email and 20 per IP per 15 minutes, counted before the check; emailed two-step codes (always for Owner and Finance staff); trusted devices bound to `User.securityEpoch` and the password hash | `lib/auth/*` |
| Sessions | Opaque token, only its SHA-256 stored; httpOnly, SameSite=Lax, Secure; rotated on sign-in, two-step and verification; revoked on reset, role change and deactivation | `lib/auth/sessions.ts`, `cookies.ts` |
| CSRF | Session-bound HMAC token in `x-csrf-token` plus a same-origin check on every mutation | `lib/auth/csrf.ts` |
| Authorisation | Every route checks on the server: team permission (`requireAccountRole`, `requireLicenseMember`) or staff permission (`adminRoute(perm)`); other accounts' ids answer 404; a test runs every admin route as every role | `lib/rbac.ts`, `lib/admin/http.ts` |
| Destructive admin actions | Reason (and typed id for refund, revoke, coupon delete); exactly one audit row in the same transaction; audit log append-only | `lib/admin/destructive.ts`, `lib/audit.ts` |
| Payments | Server re-pricing; webhook HMAC; amount, currency and provider-order checks; idempotent events; licenses only from the verified path | `lib/payments/*` |
| License keys | HMAC lookup + AES-256-GCM; shown once to the purchaser, then only after the password; masked in logs, emails and exports | `lib/licensing/keys.ts`, `crypto.ts` |
| Device API | Strict 4-8 KB bodies, per-key, per-license and per-IP limits, row lock on activation, churn cap, Ed25519 tokens | `lib/licensing/activation.ts` |
| Browser hardening | Strict nonce CSP on dynamic areas, static CSP elsewhere (`script-src-attr 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`); HSTS, COOP, Permissions-Policy, nosniff, DENY framing | `middleware.ts`, `lib/security/*`, `next.config.ts` |
| Input | Strict Zod bodies (unknown keys refused), streamed size caps, parameterised SQL, `safeNext()` for redirects | `lib/http.ts`, `lib/validation/*`, `lib/auth/redirect.ts` |
| Secrets and logs | Secrets only in the env file; `lib/env.ts` refuses placeholders and dev drivers in production; the logger redacts keys, tokens, codes, cookies and query strings | `lib/env.ts`, `lib/log.ts` |
| Abuse | Rate limits on every public write (Redis, failing closed for secret checks); bounded DB pool answering 503 | `lib/auth/rate-limit*.ts`, `lib/db.ts` |

## Background jobs

There is no worker process. Work outside a request runs in three ways:

1. **After the commit, in the same process**: email dispatch (`kickEmailDispatch()`), release notifications and
   mock webhooks in development.
2. **Scheduled HTTP calls** to `/api/cron/*` with `Authorization: Bearer <CRON_SECRET>`, made by aaPanel Cron through
   `deploy/cron-*.sh` on 127.0.0.1. Every job is idempotent, bounded per run and safe to run twice at once (rows are
   claimed with `FOR UPDATE SKIP LOCKED` or deduplicated by key).
3. **Shell tasks** on the server: the database backup.

| Task | Schedule (server clock in UTC) | What it does |
|---|---|---|
| `axiomatic-emails` -> `/api/cron/emails` | every minute | Sends due outbox emails; backoff 1/2/4/8 minutes, FAILED after 5 attempts |
| `axiomatic-reconcile` -> `/api/cron/reconcile` | every 10 minutes | Payment attempts without a webhook (up to 7 days), pending refunds after a day (every 6 hours) |
| `axiomatic-renewals` -> `/api/cron/renewals` | daily 04:00 (09:30 IST) | `renewal_30` and `renewal_7` reminders, once per license, template and term |
| `axiomatic-backup` -> `deploy/backup.sh` | daily 21:00 (02:30 IST) | `pg_dump`, 14 days kept |
| `axiomatic-maintenance` -> `/api/cron/maintenance` | daily 22:00 (03:30 IST), after the backup | Closes tickets resolved 14 days ago; deletes unfinished uploads older than 24 hours (file, then row); empties sent emails after 30 days; purges ended rate-limit buckets, sessions and auth tokens 30 days on, activity older than 24 months and webhook deliveries older than 180 days. 500 rows per statement, 240 s budget shared between tasks |

## Deployment

Test-mode release on one aaPanel VPS without Docker ([`../deploy/README.md`](../deploy/README.md),
[`deploy-today.md`](deploy-today.md)):

- **Processes.** PM2 runs `next start` as the user `axiomatic` on 127.0.0.1:3000 (`deploy/ecosystem.config.cjs`;
  `AXS_INSTANCES` for cluster mode, `AXS_HEAP_MB` caps the V8 heap of each process, 512 MB by default). aaPanel's Nginx terminates TLS (Let's Encrypt), redirects `www` and http, and
  proxies to the app with `X-Forwarded-For` (`TRUSTED_PROXY_HOPS=1`); it blocks `/api/cron/*` from the internet and
  adds no security headers of its own (the app sends them).
- **Data services.** PostgreSQL (UTF-8, C collation, memory and planner settings from `deploy/README.md`) and Redis
  (password) from the aaPanel App Store, both on localhost. Files in a private S3-compatible bucket with a CORS rule for `PUT` from the site; email through an SMTP
  provider.
- **Releases.** `deploy/deploy.sh` copies the source into `releases/<UTC timestamp>/`, links the shared
  `shared/.env.production` (mode 600), installs, checks the environment, PostgreSQL and Redis, backs up the database,
  runs `prisma migrate deploy`, builds (the build prerenders from the database), switches the `current` symlink,
  reloads PM2 and checks `/api/health`. A release that fails the health check is
  rolled back automatically (exit status 3); `rollback.sh` picks an earlier release by hand. Migrations are
  forward-only. The newest 3 releases are kept.
- **Configuration.** Everything secret is in `shared/.env.production` (generated by `scripts/gen-prod-env.mjs`);
  `lib/env.ts` validates it at start-up and refuses development drivers. The static CSP, the storage origin and HSTS
  are fixed by `next build`, so changing `STORAGE_*` or `SECURITY_HSTS_STRICT` needs a deploy, not a restart.
- **First run.** `deploy.sh --first-run` also runs `scripts/bootstrap-production.ts`: the sample catalog, settings,
  counters and the first Owner, never demo data.

Scaling beyond one server (managed PostgreSQL and Redis, more processes, a CDN for downloads, indexes, partitioning):
[`scaling.md`](scaling.md) and [`performance.md`](performance.md).

## Quality checks

| Check | What it covers |
|---|---|
| `pnpm test:unit` (`tests/unit`) | Pure logic: pricing and GST, terms, keys, tokens, permissions, copy, CSP, redaction, models |
| `pnpm test:db` (`tests/db`) | Services and routes against an isolated schema: checkout, webhooks, fulfilment, refunds, activation, portal, every admin route x every role, jobs, security epoch |
| `pnpm e2e` (`tests/e2e`) | Playwright journeys in Chrome against the dev server with the mock provider: guest purchase and claim, GST and coupons, payment outcomes, devices, admin roles and refund, catalog and settings, phone layouts, axe |
| `scripts/check-*.mjs` | Crawls and role journeys for the storefront, purchase, portal and admin, with accessibility checks |
| `scripts/smoke-prod.mjs` | Read-only checks of a deployed site (TLS, headers, health, closed dev and cron routes, webhook signature, device API) |
