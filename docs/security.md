# Security

How the app protects its data and users: the threat model, the controls and where they live, the
Content-Security-Policy rationale, secrets and their rotation, and what to do in an incident. Binding decisions stay in
[`decisions.md`](decisions.md) (Phase 7 "hardening"); operator steps in [`../deploy/README.md`](../deploy/README.md).
Recorded 2026-10-07 for the first test-mode deployment.

## Threat model (summary)

**Assets.** License keys (sold value; stored as HMAC + AES-256-GCM, never logged), the Ed25519 signing key for
activation tokens, payments and orders (amounts, GST invoices, refunds), customer and business data (names, emails,
phones, GSTINs, billing addresses, tickets and attachments), staff accounts (the admin console can refund, revoke and
issue licenses), sessions and sign-in codes, and the secrets in `.env.production`.

**Actors.** Anonymous visitors and bots; customers and their team members (Owner, Billing admin, Technical contact,
Viewer); staff (Owner, Administrator, Support, Finance); desktop and mobile apps calling the activation API; Razorpay
(webhooks); the server operator. Assumed hostile: anyone on the internet, a customer acting against another account,
a staff member acting beyond their role, a stolen or forwarded email (codes, links), a leaked browser cookie, and
injected content (an admin-entered banner, a ticket message, a product description).

| Threat | Main controls |
|---|---|
| Account takeover (password guessing, stuffing) | argon2id hashes; per-email and per-IP limits (Redis) counted before the check; same error and same work for unknown emails; optional emailed two-step codes for every account, staff included (turned on in Security or Admin > My profile; Owner and Finance turn it on once SMTP works) |
| Stolen sign-in code or reset link | codes bound to the browser that passed the password step (challenge id, only its hash stored); 10/30-minute lifetimes, 5 guesses, single use; a new code or link voids older ones |
| Trusted device outliving a security event | trusted-device cookie bound to the user's security epoch and password hash (see below) |
| Session theft | httpOnly, SameSite=Lax, Secure cookies; only the SHA-256 of the token in the database; idle expiry (customers 30 days, staff 12 hours); rotation on sign-in, two-step and verification; "sign out everywhere"; revocation on password reset, role change and deactivation |
| CSRF | HMAC CSRF token bound to the session in a header on every mutation, plus a same-origin check (Origin / Sec-Fetch-Site); cron and webhook routes take no cookies |
| Cross-account access (IDOR) | every route resolves the actor's account membership or staff permission on the server (`lib/rbac.ts`, `requireAccountRole`, `adminRoute(perm)`); foreign ids answer 404; the middleware redirect is optimistic only |
| Privilege misuse by staff | permission per route (table-driven test over every route and role), reasons and typed confirmation for destructive actions, append-only audit log with exactly one row per action |
| XSS | React escaping; no user content through `dangerouslySetInnerHTML`; JSON-LD escaped; strict nonce CSP on the portal, admin, checkout, order and auth pages; `script-src-attr 'none'` everywhere |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` |
| Payment tampering | the server re-prices every order; webhook signature, amount, currency and provider-order checks; licenses only from the signed webhook (or audited staff issue) |
| License key leakage | shown once to the purchaser (`Cache-Control: no-store`), afterwards only after the password; masked in logs, emails and exports |
| Activation API abuse | strict JSON (8 KB), HMAC lookup, per-key and per-IP limits, device-limit lock, EdDSA tokens verified offline |
| Injection | Prisma parameterised queries (raw SQL only with bound parameters), strict Zod bodies (unknown keys refused), size-capped bodies |
| Open redirects | `safeNext()` allows same-origin relative paths only (no `//`, backslashes, control characters, `/api`, auth pages) |
| Secret disclosure | secrets only in the env file (mode 600); never in code, the database, the admin UI, emails or logs (`lib/log.ts` redaction) |
| Denial of service | rate limits on every public write, body caps, statement timeouts, a bounded DB pool answering 503; Nginx `client_max_body_size 12m` |
| App compromise becoming server compromise | the app, its files, PM2, `pnpm install` and every scheduled job run as the unprivileged user `axiomatic`; aaPanel Cron tasks switch to it with `runuser`, and root never runs a file under `/www/wwwroot/axiomatic` (deploy/README.md "Privileges") |

Out of scope for this release: a WAF, bot detection beyond rate limits, malware scanning of uploads (attachments are
served as downloads from the private bucket, never rendered inline), and hardware-backed keys.

## HTTP security headers

Set by `next.config.ts` from `lib/security/headers.ts` on every response (computed by `next build`); `middleware.ts`
replaces the CSP with the strict one on the dynamic routes. Nginx and aaPanel must not add any of these (browsers
would get two copies; `scripts/smoke-prod.mjs` warns).

| Header | Value | Why |
|---|---|---|
| Content-Security-Policy | see the next section | limits what injected content can do |
| Strict-Transport-Security | `max-age=31536000` (production only); with `SECURITY_HSTS_STRICT=1` also `includeSubDomains; preload` | HTTPS only, for a year. Turn the strict form on before live sales, once every subdomain (www, mail, panels) serves valid HTTPS: preload lists take months to leave |
| X-Frame-Options | `DENY` | clickjacking, for browsers without `frame-ancestors` |
| X-Content-Type-Options | `nosniff` | no MIME sniffing of CSVs, JSON or downloads |
| Referrer-Policy | `strict-origin-when-cross-origin` | other sites see only our origin, never order-link tokens or portal paths |
| Permissions-Policy | camera, microphone, geolocation, usb, serial, hid, bluetooth, midi, display-capture, browsing-topics off; `payment=(self)`, plus the Razorpay iframes on `/checkout` and `/orders/:id` | injected code and third-party frames get no powerful features |
| Cross-Origin-Opener-Policy | `same-origin`; `same-origin-allow-popups` on `/checkout` and `/orders/:id` | no cross-origin window handles (tabnabbing, XS-leaks); Razorpay's bank and 3-D Secure windows keep working |
| X-Permitted-Cross-Domain-Policies | `none` | no Flash/PDF cross-domain policy files |

`SECURITY_HSTS_STRICT` (true/false) is validated by `lib/env.ts` at start-up and read by `next.config.ts` at build time
(a typo stops the build); a change needs a deploy, like the `STORAGE_*` values.

Not set on purpose: Cross-Origin-Embedder-Policy (would break the Razorpay iframes), Cross-Origin-Resource-Policy (mail
clients load our images cross-site), `upgrade-insecure-requests` (HSTS covers the site; it breaks local `next start`
checks over http).

## Content-Security-Policy

Two policies (`lib/security/csp.ts`) that differ only in `script-src`:

| | Strict (per request, `middleware.ts`) | Static (`next.config.ts`) |
|---|---|---|
| Routes | `/account/*`, `/admin/*`, `/checkout`, `/orders/:id`, `/sign-in`, `/register`, `/forgot`, `/reset`, `/verify`, `/invite`, `/staff-invite` | everything else: the prerendered / ISR storefront (`/`, `/software/<slug>`, `/pricing`, `/docs/*`, `/legal/*`, `/about`, `/support`, `/cart`), `/software`, `/compare`, `/contact`, APIs, 404s |
| script-src | `'self' 'nonce-<128 random bits>' 'strict-dynamic' 'sha256-<price script>' 'sha256-<banner script>'`, plus `https://checkout.razorpay.com` on `/checkout` and `/orders/:id` | `'self' 'unsafe-inline'` |

Shared: `default-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'self' <storage bucket origin>; frame-src 'self'; frame-ancestors 'none';
form-action 'self'; base-uri 'none'; object-src 'none'`, with Razorpay's frame, connect and image origins on
`/checkout` and `/orders/:id`. Development adds `'unsafe-eval'` (React refresh) and `ws:` (hot reload).

**Strict policy.** Per request the middleware makes a fresh nonce and puts the policy on the request (Next.js reads
the nonce from the request's `Content-Security-Policy` header and stamps it on every script it renders: bootstrap
chunks, the inline RSC payload, React's streaming scripts), on the response, and in `x-nonce` for server code. With
`'strict-dynamic'`, scripts loaded by those trusted scripts run too (webpack chunks, Razorpay Checkout.js, which our
bundle inserts); any other inline script, injected `<script src>`, inline event handler or `javascript:` URL is
blocked. `'self'` and the Razorpay host matter only to browsers without CSP level 3. A nonce needs a page rendered per
request, so every strict route must stay dynamic (`next build` marks them `ƒ`). `/cart` is prerendered and keeps the
static policy; it holds no secrets, and "Continue to checkout" is a full page load into the strict `/checkout`.

**Our own inline scripts** (`lib/security/inline-scripts.ts`) are allowed by SHA-256, not by nonce: they sit in the
root layout's `<head>`, which also renders the static pages, and reading the nonce there would make every storefront
page dynamic. For fixed text a hash is as strong as a nonce, so these scripts are constants; the banner's admin text
travels in the `data-banner-text` attribute (escaped by React). A new inline script must be added to
`INLINE_SCRIPTS` or the strict pages block it (`tests/unit/security-csp.test.ts` pins the hashes). JSON-LD
(`<script type="application/ld+json">`) is a data block, which CSP does not govern.

**Why the static pages keep `'unsafe-inline'`.** Prerendered and ISR pages come from the cache without a per-request
nonce, and Next.js 15 inlines each page's RSC payload as `self.__next_f.push(...)` scripts whose text changes per page,
per build and on every revalidation (an admin edit regenerates the page), so they cannot be pinned by hash either; a
hash or nonce source would also make browsers ignore `'unsafe-inline'` and block those scripts. Rendering the
storefront per request would give up its cacheable, database-independent pages. The residual risk is small: these
pages show only catalog and content data entered by staff (React-escaped, no raw HTML), take no credentials or
payments, and keep `script-src-attr 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'` and
`frame-ancestors 'none'`. Revisit when Next.js can nonce or hash prerendered pages.

**In-app navigation keeps the first document's policy.** A next/link navigation loads no new document, so the CSP
stays the one of the page the visitor entered on. Therefore: (1) the Razorpay origins exist only on `/checkout` and
`/orders/:id`, so links into those pages are plain `<a>` full page loads (Phase 3); (2) the storage bucket origin is in
`connect-src` on every page, not only on `/account/*` and `/admin/*`, or an attachment or installer upload after an
in-app link from the storefront or an order page would be blocked (the bucket is private and every upload needs a
presigned URL from our API, so this opens no new channel); (3) a portal visit that began on a storefront page and went
on through in-app links runs under the static policy, as before Phase 7. Sign-in redirects, email links, bookmarks
and reloads are full page loads and get the strict policy.

**Zod and `'unsafe-eval'`.** Zod 4 probes `Function("")` to compile faster validators. Production never allows
`'unsafe-eval'`, so the probe raised a CSP violation on every page; `instrumentation-client.ts` sets
`config({ jitless: true })` in the browser before any schema is built. The server keeps the JIT.

**Verified 2026-10-07** in Chrome (Playwright, channel "chrome") on the dev server and on a production build run with
`next start`, as a visitor, a customer (Owner) and the staff Owner: home, product, pricing, cart, catalog, contact,
docs, every auth page, checkout (visitor and customer), an order page and a missing order, all 14 portal pages and all
17 admin modules plus an unknown admin path. Each page had the expected policy, every script on a strict page carried
the nonce or a pinned hash, the page hydrated, and no CSP violation was reported. Razorpay Checkout.js loaded and opened
its `api.razorpay.com` iframe on `/checkout` and `/orders/:id` with no violation. `/dev/*` and `/api/dev/*` answered
404 in production.

## Sessions, cookies and two-step sign-in

| Cookie | Flags | Notes |
|---|---|---|
| `axs_session` | httpOnly, SameSite=Lax, Path=/, Secure in production (and whenever APP_URL is https) | opaque 32-byte token; the database keeps its SHA-256; customers 30 days idle, staff 12 hours |
| `axs_csrf` | SameSite=Lax, Path=/, Secure; not httpOnly by design | double-submit token, HMAC-bound to the session (`CSRF_SECRET`); sent back in `x-csrf-token` |
| `axs_td` | httpOnly, SameSite=Lax, Path=/api/auth, Secure | trusted device, 30 days |
| `axs_price_incl` | SameSite=Lax, Secure over https | GST display choice only |

Lax (not Strict) so links from emails into `/account` keep the session; CSRF tokens and the same-origin check cover
cross-site writes. A `__Host-` prefix would also stop a sibling subdomain from planting cookies; it means renaming the
cookies (everyone signs in again) and is listed under follow-ups.

**Two-step sign-in is optional for every account** (decisions.md 2026-10-08). Only `User.twoStepEnabled` decides
whether sign-in asks for an emailed code; no role forces it. Invitations (on acceptance) and the production bootstrap
start it off; role changes and reactivation never change it. Customers switch it in Security, staff in Admin > My
profile (`/admin/profile`), both through `POST /api/me/two-step` (turning it on needs a verified email, turning it off
the password; a staff change writes an AuditLog row, a customer change an account activity entry). Because the codes
are emailed, it is only safe to turn on once email sending works: the go-live checklist has the Owner and Finance turn
it on after the SMTP test. `/api/me/two-step`, `/api/me/password` and `/api/me/sessions` refuse staff without live
console access (403).

**Trusted devices and the security epoch.** "Trust this device" after a two-step code sets `axs_td` =
`2.<securityEpoch>.<expiry>.<HMAC-SHA256(SESSION_SECRET)>` over the user id, `User.securityEpoch`, the expiry and a
fingerprint of the password hash (`lib/auth/trusted-device.ts`). A sign-in skips the code only while all of them still
match. The epoch is incremented, invalidating every trusted device of that user at once, on: password reset, password
change, turning two-step off, staff deactivation, staff reactivation and staff role change
(`lib/auth/flows/reset-password.ts`, `change-password.ts`, `lib/portal/profile.ts`, `lib/admin/staff/service.ts`).
`tests/db/security-epoch.test.ts` proves an old cookie asks for a code again after each event. Version-1 cookies (from
before Phase 7) no longer verify, so every trusted device asks for one code after this release.

## Other controls (Phase 7 review)

- **Development routes.** `/api/dev/*` answers 404 for every method in production (`middleware.ts`); `/dev/*` pages
  404 through `app/dev/layout.tsx`; the handlers also refuse outside development. The mock payment provider, local
  storage driver, console email transport and fixture catalog are refused by `lib/env.ts` in production.
- **Errors.** API routes go through `route()` (`lib/http.ts`): known errors become the documented envelope, anything
  else a generic 500 "Something went wrong on our side" (logged redacted, no stack in production logs). Pages show
  Next.js's production error page or our error boundaries, which print only the error digest; 404s are plain pages.
- **Open redirects.** Every `next` parameter goes through `safeNext()` (`lib/auth/redirect.ts`); client-side
  redirects use the same check; download redirects go only to presigned URLs the server made; the middleware builds
  `/sign-in?next=` from the request path itself, on APP_URL's origin (never the Host header or the internal
  `localhost` URL `next start` gives middleware behind the proxy).
- **Request size.** JSON bodies are read through `parseJsonBody()` with a byte cap checked while streaming (64 KB by
  default, smaller per route; 8 KB on the device API), webhook bodies are capped, uploads never pass through the app
  (presigned PUT to the bucket, size checked afterwards), and Nginx refuses bodies over 12 MB. No Server Actions.
- **Logging.** `lib/log.ts` redacts by key (passwords, tokens, secrets, keys, codes, cookies, authorization,
  signatures, challenge ids, nonces, CSRF values, HMACs, salts and more), masks license keys, strips query strings and
  credentials from every URL in text, and masks `Bearer ...`, `Authorization: ...` and `token=` / `password=` /
  `X-Amz-Signature=` style pairs in free text (`tests/unit/security-log-redaction.test.ts`). `next start` logs no
  requests, and the Nginx access log is off because order links carry a token. The order page's status polls send
  the token in the `X-Order-Token` header, never the URL; the page URL itself (`/orders/<id>?t=`) can still reach
  the Nginx error log when the app does not answer during a restart (S2 removes that; go-live-checklist.md has the
  check).

## Secrets

All secrets live in one env file: `.env.local` in development (written by `pnpm secrets`), `shared/.env.production`
(mode 600, app user only; generated by `scripts/gen-prod-env.mjs`) on the server. They are never committed, never
stored in the database, never shown in Admin > Settings (only "configured / test / live"), never emailed and never
logged; `lib/env.ts` refuses placeholders and reports problems by name only. Production keys are generated on the
server, never copied from development (the dev signing key was rotated once already, Phase 3).

| Secret | Protects | If it leaks |
|---|---|---|
| `SESSION_SECRET` | sign-in code and trusted-device HMACs | forged trusted-device cookies (the password is still needed); rotate |
| `CSRF_SECRET` | CSRF tokens | CSRF protection weakens to the same-origin check; rotate |
| `ORDER_TOKEN_SECRET` | guest order links | anyone can mint order links (view orders, one-time key reveal of undelivered keys); rotate |
| `CRON_SECRET` | `/api/cron/*` (also blocked at Nginx) | jobs can be triggered early (idempotent); rotate |
| `LICENSE_KEY_PEPPER`, `LICENSE_KEY_ENC_KEY` | key lookup and key encryption | with a database copy, every key can be decrypted. Cannot be rotated once keys exist: treat a leak as a re-key project (re-encrypt, reissue) |
| `LICENSE_SIGNING_PRIVATE_KEY` | activation tokens | forged offline activations until apps ship a new public key |
| `PAYMENT_KEY_SECRET`, `PAYMENT_WEBHOOK_SECRET` | Razorpay API and webhook signatures | refunds or forged "paid" events; regenerate in Razorpay at once |
| `STORAGE_*` keys, `SMTP_PASSWORD`, database and Redis passwords | files, outgoing mail, data, rate limits | rotate at the provider |

**Rotation.** How to rotate each value and what users notice is the table in
[`deploy/README.md`](../deploy/README.md) "Restart, env changes and secret rotation". Rotate on a schedule (yearly), when
someone with server access leaves, and after any suspected exposure. After rotating, run
`node scripts/smoke-prod.mjs --base=https://<domain>`.

## Incident basics

1. **Notice.** Signals: the uptime alert, `pm2 logs axiomatic --err`, the Admin audit log (unexpected refunds, license
   issues, staff or settings changes), Razorpay alerts and dashboard, customer reports of codes they did not request,
   a burst of `sign_in_failed` / `rate_limited` events.
2. **Contain** (minutes, before investigating in depth):
   - A staff account: Admin > Staff & roles > Deactivate (signs them out everywhere, voids their codes, bumps their
     security epoch). If the Owner account itself is affected, a second Owner does this; keep two Owners.
   - A customer account: the customer resets the password (revokes every session and trusted device); staff can send
     the reset email from Admin > Customers.
   - Everyone at once: rotate `SESSION_SECRET` (trusted devices and codes in flight) and revoke all sessions in SQL:
     `UPDATE "Session" SET "revokedAt" = now() WHERE "revokedAt" IS NULL;`
   - A leaked secret: rotate it (deploy/README.md table). Razorpay keys: regenerate in the dashboard first.
   - Payments: pause the webhook in Razorpay only if forged events are suspected (reconciliation catches up later).
   - Take the site down only for an active compromise of the server: `pm2 stop axiomatic` (Nginx then answers 502).
3. **Preserve evidence** before cleaning up: copy `shared/logs/`, the PM2 logs, the Nginx error log and a fresh
   `bash deploy/backup.sh` dump to a safe place; note times in UTC and IST.
4. **Investigate and fix**: the audit log (`/admin/audit`, CSV export) and account activity show who did what and
   from which IP prefix; fix the cause, deploy, then rotate anything that may have been read.
5. **Notify.** Personal data breaches go to the Data Protection Board and the affected people (DPDP Act 2023), and
   reportable cyber incidents to CERT-In within 6 hours of noticing them (CERT-In directions of 28 April 2022, which
   also expect ICT logs to be kept for 180 days). The owner confirms the obligations and the log retention with
   counsel before live sales. Razorpay must hear about anything touching payments.
6. **Review**: record what happened and what changed in `docs/decisions.md`.

## Dependency audit

`pnpm audit --prod` on 2026-10-07: 7 advisories (4 high, 3 moderate), none on a path that handles untrusted input at
runtime, and none fixable by a patch-level update, so no override was added:

| Package (version) | Advisories | Path | Assessment |
|---|---|---|---|
| postcss 8.4.31 | GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849 (high); GHSA-qx2v-qp2m-jg93, GHSA-fxqj-rqcc-2cmp (moderate): source-map file reads, `</style>` in stringified CSS | `next > postcss` (Next.js pins this version) | build-time only, on our own CSS; never runs on user input. Fixed in 8.5.23 (minor). Wait for a Next.js release that bumps it; do not override Next's pinned copy |
| mysql2 3.15.3 | GHSA-3f6p-5ww8-9rcr (high), GHSA-rgwj-5xj2-c3m3 (moderate): MySQL auth downgrade, compressed-protocol inflate | `@prisma/client > prisma > mysql2` | never loaded: the app and `prisma migrate` use PostgreSQL. Fixed in 3.23.1 (minor); goes away with a Prisma update |
| deepmerge-ts 7.1.5 | GHSA-ggr8-5vv4-36mx (high): stack exhaustion on recursive objects | `@prisma/client > prisma > @prisma/config` | Prisma CLI config loading of our own config file only. Fixed in 8.0.0 (major); goes away with a Prisma update |

Re-run `pnpm audit --prod` before every deploy and before live sales; check the Next.js and Prisma release notes for
these packages when updating (stack pins: `docs/decisions.md`).

## Follow-ups

- A CSP violation report endpoint (`report-to`, rate limited, redacted) to see breakage in the field.
- `__Host-` cookie names (`__Host-axs_session`, `__Host-axs_csrf`) once a forced sign-out is acceptable.
- Full page loads for the storefront's links into `/account` and `/admin` (account menu, order page, signed-in
  banner), so portal visits that start on the storefront also run under the strict policy.
- Trusted Types once React, Next.js and Razorpay Checkout.js support them.
- Exchange the order-link token for a short-lived cookie (decisions.md Phase 3), so access logs can stay on.
