# API reference

The HTTP API the app implements today: 165 route files under `app/api`, read on 2026-10-07. Every handler's header
comment is the detailed contract (bodies, responses, limits); this page is the map. The design-time contract is
`../design_handoff_axiomatic/docs/api-contracts.md`; where the code differs, `docs/decisions.md` records why.
App developers: the device API has its own guide, [`activation-api.md`](activation-api.md).

## Conventions

- **Format.** JSON in and out (`Content-Type: application/json`; anything else is 415). Money is integer paise; times
  are ISO 8601 in UTC (CSV exports use IST dates). Request bodies are strict: unknown keys are refused (422), and bodies
  are size-capped while they stream (64 KB by default, smaller on most routes; 413 above).
- **Caching.** Every API response is `Cache-Control: no-store`, except the public catalog
  (`public, max-age=60, s-maxage=300, stale-while-revalidate=600`).
- **Rate limits.** Counted per IP, per user, per key or per license (`RATE_LIMITS` in `lib/auth/rate-limit.ts`, Redis in
  production). A refusal is 429 `too_many_attempts` with `Retry-After` and `retryAfterSec`. Limits that guard a secret
  (password, code, key) count the attempt before checking it.
- **Errors.** One envelope everywhere: `{ "error": { "code": "...", "message": "...", ...details } }`. The message is
  user-facing copy. Codes used across the API:

| Status | Code | When |
|---|---|---|
| 400 | `bad_request`, `invalid_json` | Unreadable body |
| 401 | `unauthorized` | Signed out (customer and staff routes); cron without the secret |
| 403 | `forbidden` | Role or team permission missing ("Your role (Support) doesn’t allow this.") |
| 403 | `csrf_failed` | Missing or stale CSRF token, or a cross-origin mutation; fetch a new token and retry once |
| 403 | `email_unverified`, `no_account` | Portal routes: unverified customer, or no active business account |
| 404 | `not_found` | Unknown id, and also ids that belong to another account (never 403, so ids cannot be probed) |
| 409 | route-specific | State conflicts (`trial_used`, `already_refunded`, `last_owner`, ...) |
| 410 | `code_expired`, `token_expired`, `invite_*` | Expired codes, links and invitations |
| 413 / 415 | `payload_too_large`, `unsupported_media_type` | Body over its cap, or not JSON |
| 422 | `validation_failed` | With `fieldErrors` (dotted paths) and `formErrors` |
| 422 | `reason_required`, `reason_too_long`, `confirm_mismatch` | Admin destructive actions (reason 4-500 characters, typed id) |
| 429 | `too_many_attempts` | Rate limit; `Retry-After` header |
| 500 | `internal_error` | Unexpected error (logged redacted; no details returned) |
| 502 | `payment_unavailable`, `provider_refund_failed` | Payment provider refused or unreachable |
| 503 | `unavailable` | Database saturated or unreachable (`Retry-After: 5`); also Redis down for limits that guard a secret |

### Authentication

| Kind | How | Used by |
|---|---|---|
| Public | Nothing | Catalog, health, CSRF token, contact, invitation previews |
| Session | `axs_session` cookie (httpOnly, SameSite=Lax, Secure); customers 30 days idle, staff 12 hours | `/api/auth/*`, `/api/me/*`, portal, admin |
| CSRF | `x-csrf-token` header = the `axs_csrf` cookie value from `GET /api/csrf` (HMAC-bound to the session, or "anon"), plus a same-origin check (Origin / Sec-Fetch-Site) | Every mutation except the device API, webhooks and cron |
| Verified member | Session + verified email + an active membership of the session's business account + a team permission (`TEAM_PERMS` in `lib/rbac.ts`) | `/api/account/*` |
| Staff permission | Session of an ACTIVE staff user whose role holds the permission (`PERMS` in `lib/rbac.ts`); cross-site requests refused | `/api/admin/*` |
| Order link | `t` = the order token from the order email or return URL (`o1.<exp>.<emailTag>.<sig>`, 30 days), in the body, the `X-Order-Token` header (the order page's status polls, so the token stays out of request lines) or `?t=`; or the session of a member / the placer | `/api/orders/*`, order actions in `/api/checkout/orders/:id/*` |
| Device API | `X-App-Id: <product code>` plus the license key (`/activate`) or the activation token | `/api/v1/licenses/*` |
| Cron | `Authorization: Bearer <CRON_SECRET>` (constant time; 401 with `WWW-Authenticate`) | `/api/cron/*` |
| Webhook signature | Provider HMAC of the raw body with `PAYMENT_WEBHOOK_SECRET` | `/api/webhooks/payments/:provider` |

Server CSV exports (portal and admin) also refuse `Sec-Fetch-Site: cross-site`. Account ids never come from the
client: portal routes act on the session's active account (`POST /api/me/active-account` switches it).

## Public

| Route | Purpose and response | Main errors |
|---|---|---|
| `GET /api/health` | Readiness for deploys and monitors: 200 `{ status: "ok" }` when PostgreSQL (and Redis, when configured) answer within 2 s | 503 `{ status: "unavailable" }` with `Retry-After` (never says which check failed) |
| `GET /api/csrf` | Issues the CSRF token: sets `axs_csrf`, returns `{ token }` | - |
| `GET /api/catalog/products?q=&category=&os=&license=&price=&sort=` | Published products with facets: `{ items, facets, query, total }`; unknown filter values fall back to defaults | - |
| `GET /api/catalog/products/:slug` | One published product: `{ product, plans, latestRelease, faqs, related }` | 404 for draft, hidden and unknown products |
| `GET /api/catalog/compare?ids=a,b,c` | Up to 3 published products side by side: `{ ids, products }` | - |
| `POST /api/contact` | Contact message or demo request (CSRF, "anon" binding when signed out); stores a Lead and queues the acknowledgement and the internal notice: `{ reference }` | 422, 429 (5 per hour per IP), 503 `unavailable` (asks the visitor to email sales). A filled honeypot gets a decoy 200 |

## Auth (`/api/auth/*`)

Customers and staff use the same endpoints. All mutations need CSRF; bodies are capped small.

| Route | Purpose and response | Main errors |
|---|---|---|
| `POST /api/auth/register` | `{ name, email, password, businessName?, next? }`: creates the user, a business account (Owner) and a session, emails a 6-digit code. 201 `{ user, redirectTo: "/verify" }` | 409 `email_taken`, 422, 429 (5 per hour per IP) |
| `POST /api/auth/sign-in` | `{ email, password, next? }` -> `{ requires2fa: false, redirectTo }` + session, or `{ requires2fa: true, challengeId, emailHint }` (only when the user turned two-step on and the device is not trusted; optional for every account, no role forces it) | 401 `invalid_credentials` (same for unknown email and wrong password), 429 (5 per email, 20 per IP per 15 min) |
| `POST /api/auth/sign-in/verify` | `{ challengeId, code, trustDevice }` -> `{ redirectTo }` + session (+ `axs_td` trusted-device cookie, 30 days) | 422 `invalid_code`, 410 `code_expired`, 429 |
| `POST /api/auth/sign-out` | Revokes the session; 204 (also when signed out) | - |
| `POST /api/auth/verify-email` | Session; `{ code, next? }` -> `{ verified, claimedOrders, redirectTo }`; claims guest orders with that email and rotates the session | 401, 422 `invalid_code`, 410 `code_expired`, 429 |
| `POST /api/auth/resend-code` | Session; emails a new verification code | 429 (3 per 15 min) |
| `POST /api/auth/forgot-password` | `{ email }` -> 200 `{}` always (no account discovery); emails a 30-minute single-use link | 422, 429 (per IP only, 10 per hour) |
| `GET /api/auth/reset-password?token=` | `{ email }` for the reset page | 422 `token_invalid`, 410 `token_expired` |
| `POST /api/auth/reset-password` | `{ token, password }` -> `{ redirectTo }`; revokes every session and trusted device of the user | 422 `token_invalid` / `validation_failed`, 410 `token_expired`, 429 |
| `GET /api/auth/session` | The `/api/me` body, or `{ user: null, account: null, role: null }` when signed out (never 401) | - |

## Signed-in user (`/api/me/*`)

Session required (401 otherwise); mutations need CSRF. Customers use these from the portal Security page, staff from
Admin > My profile (`/admin/profile`); `password`, `two-step` and `sessions` answer 403 for staff without live console
access (invited, deactivated, no role).

| Route | Purpose and response | Main errors |
|---|---|---|
| `GET /api/me` | `{ user: { id, name, email, kind, emailVerified, staffRole }, account, role }` | 401 |
| `PATCH /api/me` | `{ name?, phone? }` (profile) -> `{ user }` | 422, 429 (30 per 10 min) |
| `POST /api/me/active-account` | `{ accountId }` -> `{ account, role }`: the portal business switcher | 404 unless an ACTIVE membership |
| `POST /api/me/password` | `{ current, next }` -> `{ revokedSessions }`; other sessions are signed out | 422 `incorrect_password`, 429 (5 per 15 min) |
| `POST /api/me/two-step` | `{ enabled, password? }` -> `{ twoStepEnabled, changed }`; turning off needs the password. Optional for every account; a change logs "Turned on/off two-step verification" as customer account activity, or for staff as an AuditLog row (actor = target = the staff member) | 403 `email_unverified` (to turn on), 403 for staff without live access, 422 `incorrect_password`, 429 |
| `GET` / `PATCH /api/me/preferences` | Customer email preferences `{ renewals, updates, tickets, offers }`; offers records consent and withdrawal times | 403 for staff, 429 (120 writes per 10 min) |
| `GET /api/me/sessions` | Live sessions of the user, this one first (device label, IP prefix) | - |
| `DELETE /api/me/sessions` | Signs out every other session: `{ revoked }` | - |
| `DELETE /api/me/sessions/:id` | Signs out one session: `{ revoked, current, device }` | 404 for anything but the user's own live session |

## Invitations

Public; the token in the link is the credential. Previews are read-only.

| Route | Purpose and response | Main errors |
|---|---|---|
| `GET /api/invites/:token` | Team invitation preview: account, role, inviter, expiry, whether the person already has a password | 404 `invite_invalid`, 410 `invite_used` / `invite_revoked` / `invite_expired`, 429 (60 per 10 min per IP) |
| `POST /api/invites/accept` | `{ token, name?, password? }` (CSRF): joins the account, verifies the email, rotates the session: `{ redirectTo, accountId, user }` | 401 `sign_in_required`, 403 `wrong_account` / `staff_account`, 404, 410, 422, 429 (20 per 15 min per IP) |
| `GET /api/staff-invites/:token` | Staff invitation preview (role and its summary, inviter, expiry) | 404, 410, 429 |
| `POST /api/staff-invites/accept` | `{ token, name, password }` (CSRF): sets the password and signs the new staff member in (two-step off until they turn it on in My profile): `{ redirectTo: "/admin", user }` | 403 `signed_in` (sign out first), 404, 409 `invite_changed`, 410, 422, 429 |

## Checkout and orders

The cart lives in the browser; the server re-prices everything from the database. Guests may buy NEW items only;
renewal, add-on and upgrade lines need a signed-in member with the `purchases` team permission on the account that
owns the target license. Staff sessions cannot place orders (403 `staff_checkout`). Orders become PAID only through
the verified payment webhook or reconciliation, never through these routes.

| Route | Access | Purpose and response | Main errors |
|---|---|---|---|
| `POST /api/checkout/quote` | Public + CSRF | `{ items, couponCode?, billingState? }` -> lines, subtotal, discount, taxable, CGST/SGST/IGST, total, `issues` for refused lines | 422, 429 (120 per 10 min per IP; 20 with a coupon) |
| `POST /api/checkout/orders` | Public or session + CSRF | `{ items, couponCode?, billing, createAccount?, acceptTerms }` -> 201 `{ orderId, orderToken, statusUrl, checkout }` (Razorpay Checkout options, or the mock page URL). Creates Order (AWAITING_PAYMENT) + Payment (CREATED); `createAccount` also signs the new customer in | 422 `validation_failed` / `cart_invalid` / `zero_total`, 403 `forbidden` / `staff_checkout`, 409 `email_taken`, 429 (20 orders per hour per IP), 502 `payment_unavailable` |
| `POST /api/checkout/orders/:id/return` | Order link or session + CSRF | `{ providerPaymentId, providerSignature, t? }` from the hosted checkout: verifies the signature, marks the attempt AUTHORIZED and the order CONFIRMING: `{ status }` | 400 `invalid_signature`, 401 / 403 / 404, 429 (30 per 10 min per IP) |
| `POST /api/checkout/orders/:id/cancel` | Order link or session + CSRF | The buyer closed the payment window: AWAITING_PAYMENT -> CANCELED: `{ status }` | 401 / 403 / 404, 429 |
| `POST /api/checkout/orders/:id/retry` | Order link or session + CSRF | "Try again" / "Return to payment": a new or reopened payment attempt for the same order: 201 like order creation | 409 `not_retryable` / `order_unavailable`, 502, 429 |
| `GET /api/orders/:id/status` (token in `X-Order-Token`, or `?t=`) | Order link, account member (`invoices.view`) or the placer | The order page's data, polled every 2 s. The purchaser receives each issued key once (then masked); never to cross-site requests | 401 signed out without a token, 403 `order_link_expired`, 404 (also for foreign orders and bad tokens), 429 (300 per 5 min per IP) |
| `GET /api/orders/:id/invoice.pdf?t=` | As the status route | The tax invoice PDF (attachment) | 409 `invoice_unavailable` before payment, 429 (30 per 10 min per IP) |
| `POST /api/orders/:id/downloads` | As the status route + CSRF (a member reaching it by session also needs `downloads`) | `{ releaseFileId, t? }` -> presigned download link, only through licenses this order issued | 403 `not_entitled` with `reason`, 404, 429 |

## Customer portal (`/api/account/*`)

Session of a verified customer with an active membership of the session's business account (401, 403
`email_unverified` / `no_account`); the team permission in the second column (403 `forbidden` without it); CSRF on
every mutation. Objects of other accounts answer 404.

| Route | Team permission | Purpose |
|---|---|---|
| `GET /api/account/overview` | `licenses.view` | Alerts, KPIs, device-slot use, renewal timeline, spend by product; recent activity for Owners only |
| `GET /api/account/software` | any role | Licensed products with releases and what may be downloaded (`canDownload` false without `downloads`) |
| `POST /api/account/downloads` | `downloads` | `{ releaseFileId }` -> presigned link (at most 10 minutes); 403 `not_entitled` with `reason` (`no_license`, `revoked`, `suspended`, `expired`, `updates_ended`, `not_released`); 30 per hour |
| `GET /api/account/licenses` | `licenses.view` | Licenses (masked keys) with status, product, search and sort |
| `GET /api/account/licenses/:id` | `licenses.view` | One license: terms, devices, history, renewal options |
| `POST /api/account/licenses/:id/reveal` | `keys.reveal` | `{ password }` -> `{ key, hideAt }`; 422 `incorrect_password`, 409 `license_revoked`, 429 (5 per 15 min) |
| `POST /api/account/licenses/:id/devices/:deviceId/deactivate` | `devices.manage` | Frees a slot; 429 `reset_limit` after the yearly self-service limit, 409 `already_deactivated` / `license_not_usable` |
| `GET /api/account/devices` | `licenses.view` | Devices of every license, filters, stats |
| `PATCH /api/account/devices/:id` | `devices.manage` | `{ name?, locationId? }`; 409 `device_inactive` |
| `GET` / `POST /api/account/locations`, `PATCH` / `DELETE /api/account/locations/:id` | read: `licenses.view`; write: `devices.manage` | Device locations (deleting moves devices to Unassigned); 409 `location_limit` |
| `POST /api/account/trials` | `trials.start` | `{ productId }` -> 201 trial license (never the key); 409 `trial_used`, 422 `trial_unavailable` |
| `GET /api/account/orders`, `GET /api/account/orders/export.csv` | `invoices.view` | Orders (8 per page) and the accountant CSV (GST split, at most 10,000 rows) |
| `GET` / `PATCH /api/account/billing` | read: `invoices.view`; write: `billing.edit` | Billing and tax details, invoice contacts, payments (newest 100) |
| `GET` / `POST /api/account/team`, `PATCH` / `DELETE /api/account/team/:memberId`, `POST .../:memberId/resend` | `team.manage` (Owner) | Members and invitations; `emailSent` false when the invitation email failed; 409 `already_member` / `team_full` / `last_owner` / `not_invited`, 403 `own_role` / `remove_self` |
| `GET` / `POST /api/account/tickets`, `GET /api/account/tickets/:id`, `POST .../messages`, `POST .../status` | read: `tickets.view`; write: `tickets.create` | Support tickets (staff notes never returned); 409 `ticket_resolved` / `ticket_closed` / `ticket_changed` |
| `POST /api/account/uploads`, `POST .../:id/confirm`, `GET .../:id/download` | write: `tickets.create`; download: `tickets.view` | Ticket attachments: presigned PUT (5 minutes, PNG/JPEG/PDF/TXT, 10 MB), confirm, presigned GET (`?redirect=1` for 303); 503 `upload_unavailable` |
| `GET` / `PATCH /api/account/notifications`, `POST .../read` | any role | In-app notifications and email preferences |
| `GET /api/account/search?q=` | `licenses.view` | Licenses, devices, orders and tickets (a pasted full key matches by hash) |
| `GET /api/account/activity`, `GET .../export.csv` | `activity.view` (Owner) | Activity log (24 months) and its CSV |
| `GET /api/account/export` | `team.manage` (Owner) | The account's data as JSON (no keys, hashes or staff notes); 5 per hour |

Team permissions by role: Owner has all; Billing admin `purchases`, `billing.edit`, `tickets.create`, `trials.start`;
Technical contact `downloads`, `keys.reveal`, `devices.manage`, `tickets.create`, `trials.start`; every role (Viewer
included) the three `*.view` permissions. `team.manage` and `activity.view` are Owner only.

## Admin (`/api/admin/*`)

Every handler is built with `adminRoute(perm)` (`lib/admin/http.ts`): cross-site requests are refused (403), then a
staff session whose role holds `perm` is required (401 signed out; 403 for customers, invited or deactivated staff and
other roles), then CSRF and same origin on every mutation. Bodies are strict Zod objects. Each route and its
permission is registered in `lib/admin/routes/<area>.ts`; `tests/db/admin-permissions.test.ts` fails for an
unregistered handler or a permission that differs from the handler's, and calls every entry as signed out, as a
customer and as each role.

**Lists** take `?q=&filter[x]=&sort=-field&page=&pageSize=` and answer `{ items, total, page, pageSize }`; bad
filters, sorts and pages fall back to defaults (never 422); `pageSize` is capped at 100. **CSV exports**
(`.../export.csv`) need `reports.export` (Owner, Finance) on top of the module, except the audit export
(`audit.view`) and the staff export (`staff.manage`); Leads, FAQs and Templates exports need the module permission
and `reports.export`. Every export writes an "Exported report" audit row and counts against 60 exports per 10 minutes
per staff member. **Destructive actions** (`DESTRUCTIVE_ACTIONS` in `lib/rbac.ts`) need `reason` (4-500 characters;
422 `reason_required` / `reason_too_long`), and refund, license revoke and coupon delete also the typed id in
`confirmId` (422 `confirm_mismatch`); each success writes exactly one audit row in the same transaction.

Permissions (`PERMS` in `lib/rbac.ts`):

| Permission | Roles |
|---|---|
| `products.manage`, `pricing.manage`, `releases.manage`, `content.manage`, `templates.manage`, `licenses.revoke`, `audit.view` | Owner, Administrator |
| `customers.manage`, `licenses.manage`, `renewals.remind`, `tickets.manage`, `leads.view` | Owner, Administrator, Support |
| `customers.view`, `orders.view`, `orders.resend_invoice` | every role |
| `refunds.issue`, `reports.export` | Owner, Finance |
| `payments.replay`, `coupons.manage`, `reports.view` | Owner, Administrator, Finance |
| `staff.manage`, `settings.manage` | Owner |

"Any staff" below means any ACTIVE staff member (no permission).

### Overview and reports
| Route | Permission | Notes |
|---|---|---|
| `GET /api/admin/overview?range=7d,30d,90d,12m` | any staff | KPIs, revenue chart, payment statuses, webhook results, products, license health, support workload; latest audit rows only with `audit.view` |
| `GET /api/admin/reports?range=` | `reports.view` | Sales by month and product, GST summary (credit notes apart), license health, support workload |
| `GET /api/admin/reports/export.csv?report=<key>&range=` | `reports.export` | 11 reports (sales register, GST by state, refunds, license register, renewal forecast, support SLA, ...); 422 for an unknown report |

### Catalog: products, categories, plans, releases
| Route | Permission | Notes |
|---|---|---|
| `GET /api/admin/products`, `GET .../:id` | any staff | |
| `POST /api/admin/products`, `PATCH .../:id` | `products.manage` | Created as DRAFT; 409 `code_locked` once licenses exist |
| `POST .../products/:id/publish`, `POST .../:id/hide` | `products.manage` | Reason; 409 `not_ready` with blockers (content, a plan on sale, a published stable release with an installer), `already_published` / `not_published` |
| `GET /api/admin/categories`, `GET .../:id` / `POST`, `PATCH`, `DELETE .../:id` | any staff / `products.manage` | Delete needs a reason; 409 `category_in_use` |
| `GET /api/admin/plans`, `GET .../:id` | any staff | |
| `POST /api/admin/plans`, `PATCH .../:id`, `POST .../:id/archive`, `.../:id/restore`, `POST .../bulk-archive` | `pricing.manage` | Price changes audited old -> new; archive and restore need a reason; plans are never deleted |
| `GET /api/admin/releases`, `GET .../:id` | any staff | |
| `POST /api/admin/releases`, `PATCH`, `DELETE .../:id` | `releases.manage` | Drafts; delete needs a reason (drafts only, 409 `not_draft`) |
| `POST .../releases/:id/files`, `POST .../files/confirm`, `DELETE .../files/:fileId` | `releases.manage` | Presigned installer upload, then confirm (size check, server SHA-256); removing needs a reason; 422 `upload_mismatch`, 503 `upload_unavailable` |
| `POST .../releases/:id/publish`, `POST .../:id/withdraw` | `releases.manage` | Publish needs an installer (409 `no_installers`) and notifies entitled accounts after the response; withdraw needs a reason |
| `GET .../products/export.csv`, `.../plans/export.csv`, `.../releases/export.csv` | `reports.export` | |

Catalog writes revalidate the storefront cache.

### Orders, payments and refunds
| Route | Permission | Notes |
|---|---|---|
| `GET /api/admin/orders`, `GET .../:id`, `GET .../:id/invoice.pdf` | `orders.view` | Search by order id, invoice number, email, business, GSTIN or payment id; date presets in IST |
| `POST /api/admin/orders/:id/refund` | `refunds.issue` | `{ reason, confirmId, amountPaise?, paymentId? }`: provider refund first, then Refund (PENDING) + credit note, license revocation or term reversal and the audit row in one transaction. `paymentId` of a duplicate captured payment refunds that payment alone. 409 `already_refunded` / `not_refundable`, 422 `confirm_mismatch`, 502 `provider_refund_failed` |
| `POST /api/admin/orders/:id/review` | `refunds.issue` | `{ reason }`: closes a REVIEW; 409 `not_in_review` / `refund_first` / `refund_pending` |
| `POST /api/admin/orders/:id/resend-invoice`, `POST .../resend-invoices` | `orders.resend_invoice` | Queues the confirmation email with the invoice again; 409 `invoice_unavailable` / `already_queued` |
| `POST /api/admin/webhooks/:id/replay` | `payments.replay` | Re-runs a stored, signature-valid event through the idempotent handler; 409 `not_replayable` / `ambiguous_event` |
| `GET /api/admin/orders/export.csv` | `reports.export` | Accountant CSV (at most 10,000 rows, or the selected ids) |

### Customers, licenses and renewals
| Route | Permission | Notes |
|---|---|---|
| `GET /api/admin/customers`, `GET .../:id` | `customers.view` | Business accounts through their first active Owner, lifetime value, paid orders |
| `POST .../customers/:id/resend-verification`, `POST .../:id/password-reset` | `customers.manage` | Emails a code or a reset link (never returned); 409 `already_verified` / `no_owner` / `no_password` |
| `GET /api/admin/licenses`, `GET .../:id` | any staff | Finance reads only; keys masked |
| `POST /api/admin/licenses` | `licenses.manage` | Manual issue `{ accountId, planId, quantity?, reason }`; the key is never returned (the Owner gets the `license_issued` email) |
| `POST .../licenses/:id/suspend`, `.../reinstate`, `.../extend`, `.../reset-devices`, `.../devices/:deviceId/deactivate`, `POST .../licenses/bulk` | `licenses.manage` | Reason required; 409 `already_suspended` / `not_suspended` / `license_revoked` / `already_deactivated` |
| `POST .../licenses/:id/revoke` | `licenses.revoke` | Reason and the typed license id |
| `GET /api/admin/renewals` | `customers.view` | Licenses ending in 60 days or ended in the last 30 |
| `POST /api/admin/renewals/remind` | `renewals.remind` | `{ licenseIds }` (1-100): "Send reminder now" |
| `GET .../customers/export.csv`, `.../licenses/export.csv`, `.../renewals/export.csv` | `reports.export` | |

### Coupons, content, templates and leads
| Route | Permission | Notes |
|---|---|---|
| `GET /api/admin/coupons`, `GET .../:code` | any staff | |
| `POST /api/admin/coupons`, `PATCH .../:code`, `POST .../:code/pause`, `.../:code/activate`, `DELETE .../:code` | `coupons.manage` | Created paused; delete needs a reason and the typed code, 409 `coupon_used` once any order used it |
| `GET` / `POST /api/admin/faqs`, `GET` / `PATCH` / `DELETE .../:id`, `POST .../:id/move`, `POST .../bulk` | `content.manage` | Delete needs a reason |
| `GET` / `PATCH /api/admin/content/banner`, `.../content/sample-notice` | `content.manage` | Site banner and sample notice; revalidate the storefront |
| `GET /api/admin/templates`, `GET` / `PATCH .../:id` | `templates.manage` | 422 for unknown `{{placeholders}}` |
| `POST /api/admin/templates/:id/test` | `templates.manage` | Sends the (unsaved) copy to the signed-in staff member only; 10 per hour; 409 `send_failed` |
| `GET /api/admin/leads`, `GET` / `PATCH .../:id` | `leads.view` | Contact and demo requests; status and notes |
| `GET .../coupons/export.csv` | `reports.export` | |
| `GET .../faqs/export.csv`, `.../templates/export.csv`, `.../leads/export.csv` | the module permission and `reports.export` (Owner only in practice) | |

### Tickets
| Route | Permission | Notes |
|---|---|---|
| `GET /api/admin/tickets`, `GET` / `PATCH .../:id`, `POST .../bulk` | `tickets.manage` | Status, priority, assignee (each change audited); bulk "assign to me" / "resolve" |
| `POST /api/admin/tickets/:id/messages` | `tickets.manage` | `{ body, internal, attachmentIds }`: a public reply notifies the customer; internal notes never reach the portal |
| `POST .../tickets/:id/uploads`, `POST .../uploads/:uploadId/confirm`, `GET .../attachments/:uploadId` | `tickets.manage` | Staff attachments as Upload rows of the ticket's account; presigned links |

### Staff, audit and settings
| Route | Permission | Notes |
|---|---|---|
| `GET` / `POST /api/admin/staff`, `GET` / `PATCH .../:id` | `staff.manage` | Invite `{ email, role }` -> `{ staff, emailSent }`; role change needs a reason and signs the person out (two-step sign-in is never changed here: each person sets it in My profile); 409 `customer_email` / `already_staff` / `already_invited` / `own_role` / `last_owner` / `staff_changed` |
| `POST .../staff/:id/deactivate`, `.../reactivate`, `.../resend-invite`, `DELETE .../:id/invite` | `staff.manage` | Reasons (not resend); deactivation signs them out everywhere; 409 `deactivate_self` / `not_invited` |
| `GET /api/admin/audit`, `GET .../:id`, `GET .../export.csv` | `audit.view` | Append-only: no write routes |
| `GET /api/admin/settings`, `PATCH .../settings/:section` | `settings.manage` | Sections `business`, `tax`, `licensing`, `sample-notice`; one audit row per changed field; integrations show configured or not, never values |
| `GET /api/admin/staff/export.csv` | `staff.manage` | |

## Payment webhooks

`POST /api/webhooks/payments/:provider`: no session, cookies or CSRF; only the configured `PAYMENT_PROVIDER` is
accepted (any other name is 404). The raw body (at most 256 KB) is checked against `PAYMENT_WEBHOOK_SECRET` in
constant time (Razorpay: `X-Razorpay-Signature`; mock: `x-mock-signature`).

| Outcome | Response |
|---|---|
| Missing or bad signature | 401 `invalid_signature`; a WebhookDelivery row (recorded up to 30 per 10 minutes per IP), no state change |
| Valid signature, body not understood | 200 `{ result: "invalid_payload" }` |
| Valid signature, an event the order state machine ignores | 200 `{ result: "ignored" }` |
| Processed | 200 `{ result }`: `fulfilled`, `duplicate_ignored`, `already_paid`, `marked_failed`, `stale_attempt`, `order_in_review`, `amount_mismatch`, `refund_processed`, `refund_failed`, `unknown_refund`, `unknown_order`, `fulfilment_failed` |
| Database unavailable | 500, so the provider retries |

Razorpay must send `payment.captured`, `order.paid` (treated as a capture), `payment.failed`, `refund.processed` and
`refund.failed`. Valid deliveries are never rate limited. Processing, idempotency and fulfilment:
[`architecture.md`](architecture.md#purchase-to-activation).

## Scheduled jobs (`/api/cron/*`)

`GET` or `POST`, `Authorization: Bearer <CRON_SECRET>` (401 `unauthorized` otherwise), no cookies, `no-store`,
counts and ids only. In production the aaPanel Cron tasks call them through `deploy/cron-*.sh` on 127.0.0.1; the
proxy blocks them from the internet.

| Route | Schedule | Does | Response |
|---|---|---|---|
| `/api/cron/emails` | every minute | Sends due outbox emails (retries with backoff; FAILED after 5 attempts) | `{ sent, failed }` |
| `/api/cron/reconcile` | every 10 minutes | Asks the provider about payments whose webhook never came, and about refunds still pending after a day | the run summary, refunds under `refunds` |
| `/api/cron/renewals` | daily | `renewal_30` (23-30 days left) and `renewal_7` (last 7 days) reminders, once per license, template and term | `{ queued, skipped }` |
| `/api/cron/maintenance` | daily, after the backup | Closes tickets resolved 14 days ago, deletes unfinished uploads, redacts old sent emails, purges ended sessions, tokens, rate-limit buckets, old activity and webhook deliveries | the counts per task, `more` for unfinished tasks; 500 with `failed` when a task failed |

## Device activation API (`/api/v1/licenses/*`)

For the desktop and Android apps; full guide with token verification, fingerprints, offline behaviour and retries:
[`activation-api.md`](activation-api.md). No cookies, session or CSRF; header `X-App-Id: <product code>` is required
(400 `invalid_app_id`); strict JSON bodies; `no-store`.

| Route | Credential | Success | Main errors |
|---|---|---|---|
| `POST /api/v1/licenses/activate` | `{ licenseKey, deviceFingerprint, deviceName, os, appVersion }` (4 KB) | 200 `{ status: "activated" or "already_active", licenseId, activationToken, plan, expiresAt, updatesUntil, deviceLimit, devicesUsed, offlineGraceDays }` | 404 `invalid_key` (also malformed keys), 403 `license_revoked` / `license_suspended` / `license_expired`, 422 `wrong_product`, 409 `activation_limit_reached` (with `devicesUsed`, `deviceLimit`, `manageUrl`), 429 `activation_churn`, 429 (60 per min per IP, 10 per min per key) |
| `POST /api/v1/licenses/validate` | `{ activationToken, deviceFingerprint, appVersion }` (8 KB) | 200 `{ valid: true, status, expiresAt, updatesUntil, latestEligibleVersion, nextCheckBefore, activationToken }` | `{ valid: false, reason, error }` with 401 `invalid_token` / `token_expired` / `fingerprint_mismatch`, 403 `license_revoked` / `license_suspended` / `license_expired` / `device_deactivated`, 422 `wrong_product`; 429 (60 per min per IP, 30 per min per license) |
| `POST /api/v1/licenses/deactivate` | `{ activationToken, deviceFingerprint }` (8 KB) | 200 `{ status: "deactivated" or "already_deactivated", devicesUsed }` | 401 `invalid_token` / `token_expired` / `fingerprint_mismatch`, 422 `wrong_product`, 429 |

Tokens are Ed25519-signed JWTs (`{ lic, fp, prod }`), valid for the offline grace (7 days) or until the license ends,
and refreshed by `/validate` up to 30 days past expiry. A device deactivation from the app does not count toward the
customer's yearly self-service limit.

## Development only (`/api/dev/*`)

404 for every method in production (middleware) and refused by the handlers outside development.

| Route | Purpose |
|---|---|
| `POST /api/dev/mock-checkout` | Outcomes of the mock payment page (`/dev/mock-checkout`): success, pending, failed, canceled; sends signed webhooks to the real webhook route (`PAYMENT_PROVIDER=mock` only) |
| `POST /api/dev/mock-checkout/bank` | The bank's final answer for a pending mock payment |
| `GET` / `PUT /api/dev/storage/<key>?exp=&sig=` | The local storage driver's signed download and upload URLs (`STORAGE_DRIVER=local` only) |

Development pages (no API): `/dev/ui` (component gallery), `/dev/mailbox` (emails of the console transport, with codes
and links), `/dev/mock-checkout`.
