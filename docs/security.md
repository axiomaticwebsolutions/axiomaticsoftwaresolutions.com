# Security

How the app protects its data and users: the threat model, the controls and where they live, the
Content-Security-Policy rationale, secrets and their rotation, and what to do in an incident. Binding decisions stay in
[`decisions.md`](decisions.md) (Phase 7 "hardening"); operator steps in [`../deploy/README.md`](../deploy/README.md).
Recorded 2026-10-07 for the first test-mode deployment.

## Threat model (summary)

**Assets.** License keys (sold value; stored as HMAC + AES-256-GCM, never logged), the Ed25519 signing key for
activation tokens, payments and orders (amounts, GST invoices, refunds), customer and business data (names, emails,
phones, GSTINs, billing addresses, tickets and attachments), staff accounts (the admin console can refund, revoke and
issue licenses), sessions and sign-in codes, the secrets in `.env.production`, and the payment, email and storage
credentials saved in Admin > Settings > Integrations (encrypted in the database).

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
| Session theft | httpOnly, SameSite=Lax, Secure cookies; only the SHA-256 of the token in the database; idle expiry (customers 30 days, staff 12 hours); rotation on sign-in, two-step and verification; "sign out everywhere"; revocation on password reset, role change, deactivation and a staff change of a customer's email |
| CSRF | HMAC CSRF token bound to the session in a header on every mutation, plus a same-origin check (Origin / Sec-Fetch-Site); cron and webhook routes take no cookies |
| Cross-account access (IDOR) | every route resolves the actor's account membership or staff permission on the server (`lib/rbac.ts`, `requireAccountRole`, `adminRoute(perm)`); foreign ids answer 404; the middleware redirect is optimistic only |
| Privilege misuse by staff | permission per route (table-driven test over every route and role), reasons and typed confirmation for destructive actions, append-only audit log with exactly one row per action |
| XSS | React escaping; no user content through `dangerouslySetInnerHTML`; JSON-LD escaped; strict nonce CSP on the portal, admin, checkout, order and auth pages; `script-src-attr 'none'` everywhere |
| Clickjacking | `frame-ancestors 'none'` and `X-Frame-Options: DENY` |
| Payment tampering | the server re-prices every order (staff-created orders too); webhook signature, amount, currency and provider-order checks; licenses only from the signed webhook, an audited manual staff issue, or an Owner/Finance offline payment record (reason required, amount equal to the server total, idempotent, one transaction through the webhook's own fulfilment code, audited; see "Offline payments" below); a late capture of a payment attempt a staff edit replaced goes to REVIEW |
| License key leakage | shown once to the purchaser (`Cache-Control: no-store`), afterwards only after the password; masked in logs, emails and exports |
| Activation API abuse | strict JSON (8 KB), HMAC lookup, per-key and per-IP limits, device-limit lock, EdDSA tokens verified offline |
| Injection | Prisma parameterised queries (raw SQL only with bound parameters), strict Zod bodies (unknown keys refused), size-capped bodies |
| Open redirects | `safeNext()` allows same-origin relative paths only (no `//`, backslashes, control characters, `/api`, auth pages) |
| Secret disclosure | secrets only in the env file (mode 600) or, for the Admin-saved integrations, AES-256-GCM encrypted in the database with a key derived from `LICENSE_KEY_ENC_KEY` (a database copy alone reveals nothing); never in code, the admin UI (only "set" and the last 4 characters of long secrets), API responses, emails, audit rows or logs (`lib/log.ts` redaction) |
| Owner account takeover redirecting payments, email or storage | only the Owner holds `integrations.manage`; every save, clear and remove re-asks the password (5 tries / 15 min); CSRF and same-origin; every change and test is audited (fields by label); two-step sign-in recommended for the Owner once email works; production refuses private-network SMTP hosts and storage endpoints (SSRF guard below) |
| Denial of service | rate limits on every public write, body caps, statement timeouts, a bounded DB pool answering 503; Nginx `client_max_body_size 12m` |
| App compromise becoming server compromise | the app, its files, PM2, `pnpm install` and every scheduled job run as the unprivileged user `axiomatic`; aaPanel Cron tasks switch to it with `runuser`, and root never runs a file under `/www/wwwroot/axiomatic` (deploy/README.md "Privileges") |

Out of scope for this release: a WAF, bot detection beyond rate limits, malware scanning of uploads (attachments are
served as downloads from the private bucket, never rendered inline), and hardware-backed keys.

## HTTP security headers

Set by `next.config.ts` from `lib/security/headers.ts` on every response (computed by `next build`); `middleware.ts`
(Node.js runtime) replaces the CSP on every page: the strict one on the dynamic routes, the static one with the
runtime bucket origin everywhere else. Nginx and aaPanel must not add any of these (browsers would get two copies;
`scripts/smoke-prod.mjs` warns).

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
(a typo stops the build); a change needs a deploy.

Not set on purpose: Cross-Origin-Embedder-Policy (would break the Razorpay iframes), Cross-Origin-Resource-Policy (mail
clients load our images cross-site), `upgrade-insecure-requests` (HSTS covers the site; it breaks local `next start`
checks over http).

## Content-Security-Policy

Two policies (`lib/security/csp.ts`) that differ only in `script-src`:

| | Strict (per request, `middleware.ts`) | Static (`middleware.ts` on pages; `next.config.ts` elsewhere) |
|---|---|---|
| Routes | `/account/*`, `/admin/*`, `/checkout`, `/orders/:id`, `/sign-in`, `/register`, `/forgot`, `/reset`, `/verify`, `/invite`, `/staff-invite` | everything else: the prerendered / ISR storefront (`/`, `/software/<slug>`, `/pricing`, `/docs/*`, `/legal/*`, `/about`, `/support`, `/cart`), `/software`, `/compare`, `/contact`, 404s; APIs and `/_next` assets get `next.config.ts`'s copy, which has no bucket origin |
| script-src | `'self' 'nonce-<128 random bits>' 'strict-dynamic' 'sha256-<price script>' 'sha256-<banner script>'`, plus `https://checkout.razorpay.com` on `/checkout` and `/orders/:id` | `'self' 'unsafe-inline'` |

Shared: `default-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'self' <storage bucket origin>; frame-src 'self'; frame-ancestors 'none';
form-action 'self'; base-uri 'none'; object-src 'none'`, with Razorpay's frame, connect and image origins on
`/checkout` and `/orders/:id`. Development adds `'unsafe-eval'` (React refresh) and `ws:` (hot reload).

**Uploaded branding files** (`/brand/*`) get `default-src 'none'; style-src 'unsafe-inline'; sandbox` from the middleware
instead of a page policy ("Branding uploads" below).

**The bucket origin is a runtime value** (since 2026-10-08, decisions.md "Admin-configurable integrations"). The
storage bucket can be changed in Admin > Settings > Integrations, so it cannot be baked in by `next build`.
`middleware.ts` runs in the Node.js runtime (`config.runtime = "nodejs"`) and its matcher covers every page
(prerendered, ISR and dynamic) plus `/api/dev/*`, but no other `/api` route and no `/_next` asset. On each page it asks
`lib/integrations/csp-origin.ts` for the origin of the effective storage configuration and sets it on the strict or
the static policy; the middleware's header replaces the `next.config.ts` one (Next.js applies config headers first,
middleware headers after them). The origin is always one exact origin: the endpoint's origin for path-style stores, or
`https://<bucket>.<host>` for virtual-hosted ones, never a wildcard such as `*.r2.cloudflarestorage.com` (that would let
injected code send data to any bucket on the provider). Local disk or "not configured" adds nothing.
- The lookup goes through the integration resolver's in-process cache (30 s; a save clears it at once in the process
  that saved; other processes follow within 30 s). The middleware never throws and never makes a page wait more than
  once per cold process (1 s cap; instrumentation warms the cache at start-up). While the database is down it keeps
  the last known origin; with none known it sends no bucket origin (uploads fail visibly, pages still render).
- On static pages the middleware also drops any client-sent `Content-Security-Policy` and `x-nonce` request headers,
  so nothing can hand the renderer a forged nonce now that those pages pass through it.
- A tab opened before a storage change keeps its old policy until it reloads. The Settings page reloads itself after a
  storage save, clear or remove (so an upload right after it works); the Admin card asks to reload other tabs.

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
change, turning two-step off, staff deactivation, staff reactivation, staff role change and an admin email change of a
customer (`lib/auth/flows/reset-password.ts`, `change-password.ts`, `lib/portal/profile.ts`,
`lib/admin/staff/service.ts`, `lib/admin/customers/records.ts`).
`tests/db/security-epoch.test.ts` proves an old cookie asks for a code again after each event. Version-1 cookies (from
before Phase 7) no longer verify, so every trusted device asks for one code after this release.

## Staff powers over customer accounts (admin records, 2026-10-08)

Admin > Customers lets staff create customers, fix their details and confirm emails (`docs/admin-records-design.md`
PART A; decisions.md "Admin records"). Each action is checked on the server (`adminRoute(perm)` plus, for "verified",
`customers.verify_email`), needs CSRF and the same origin, takes a reason first and writes one AuditLog row with field
names only.

| Action | Permission | Owner | Administrator | Support | Finance |
|---|---|---|---|---|---|
| Create a customer (`POST /api/admin/customers`) | `customers.create` | yes | yes | yes | no |
| Edit name, mobile, email and business details (`PATCH /api/admin/customers/:id`) | `customers.edit` | yes | yes | yes | no |
| Mark an email verified, or tick "verified" when creating or changing an email | `customers.verify_email` | yes | yes | yes | no |
| Create a set-password link, resend verification, send a password reset | `customers.manage` | yes | yes | yes | no |
| View customers | `customers.view` | yes | yes | yes | yes |

- **Marking an email verified** voids the person's open verification codes and claims that address's guest orders
  (and their licenses) into the account they created and own, exactly as entering the emailed code does. Staff do it
  only after confirming the person owns the address; the confirmation dialog says what moves. The same holds for
  "Email already verified" on create and "verified" on an email change. Every one of these audit rows lists the
  orders that moved by id ("· 2 guest orders moved to this account: AX-…"), so a verification that handed someone
  else's purchases to an account is traceable. Accepted risk (owner decision, 2026-10-08): Owner, Administrator and
  Support can all verify, and the staff member who creates a customer also sees the one-time set-password link, so a
  dishonest staff member could take over a guest buyer's address; the audit row with the order ids, the email to the
  address and /forgot (which lets the real owner reset the password) are the controls.
- **Email changes** bump the security epoch (every trusted device asks for a code again), revoke every session, void
  open EMAIL_VERIFY, PASSWORD_RESET, LOGIN_OTP and TEAM_INVITE tokens, clear verification unless ticked, and queue a
  notice to the OLD address (only a hint of the new one), so a socially engineered change is visible to the real owner.
  Team invitations are voided because a link mailed to the old address could otherwise set the password of a customer
  who has none and verify the NEW address; as defence in depth, accepting a team invitation is refused (410
  `invite_revoked`) whenever the invitee's email is no longer the address the link was sent to
  (`lib/portal/invites.ts`). The inviting owner resends the invitation.
- **Set-password links** (customers created by staff have no password; nobody but the customer ever knows it): a
  `PASSWORD_RESET` token with `meta.purpose = "set_password"`, single use, 256-bit secret with only its SHA-256 stored,
  bound to the address, valid 7 days. It is shown once to the staff member who created it (201 body, `no-store`) and
  emailed directly; it is never stored in plain text, logged, audited or put in a URL the console navigates to. A new
  link, a password reset or an email change voids it; it is refused once the account has a password (defence in
  depth in `findResetToken`). Completing it sets the password but does not verify the email. 5 links an hour per
  customer, separate from the public /forgot limit. /forgot sends a staff-created customer without a password a
  30-minute set-password link.
- **No takeover through registration.** A customer staff created (`User.createdByStaffId`) is never treated as a
  team-invite placeholder, so /register and checkout "Create an account" for that address answer 409 instead of
  setting a password on it.
- Staff never see or set a customer's password, and staff addresses cannot be used for customers (409).
- **Staff never receive the one-time license key.** A staff session is never the purchaser of an order
  (`lib/orders/access.ts`), even with a valid order link. The payment links staff copy and share are **pay-only** order
  links (`lib/orders/token.ts`: `p1.<exp>.<emailTag>.<sig>`, signed over `order-pay:p1:…`, so a pay-only link can't be
  turned into a full one): they open the order, its invoice and "Pay now", never the one-time key view, even signed out
  in a private window, and a payment started from one answers with a pay-only token. The customer gets the key from the
  order_confirmation email (a full link signed at payment) or reveals it in their account. A staff session also never
  pays, accepts the terms, cancels or reports a return for a customer's order (403 `staff_checkout`), even with a link;
  a signed-out link holder can, which is why the link should only go to the customer.

## Staff powers over orders and offline payments (admin records, 2026-10-08)

Admin > Orders lets Owner and Finance create orders for a customer, edit or cancel unpaid ones, record payments
received outside the payment provider and correct the billing details of paid orders (`docs/admin-records-design.md`
PART B; decisions.md "Admin records" D10-D20). Every route is checked on the server (`adminRoute(perm)`; the quote of
an existing order also needs `orders.edit`), needs CSRF and the same origin, is rate limited per staff member, takes a
reason first (except the read-only quote, re-sharing a payment link and PDF downloads) and writes one AuditLog row with
field names, amounts and document numbers only (never a token, a link or a key).

| Action | Permission | Owner | Administrator | Support | Finance |
|---|---|---|---|---|---|
| Quote, create a payment-link order, re-share or email its link | `orders.create` | yes | no | no | yes |
| Edit an unpaid order's items, coupon or billing; cancel an unpaid order | `orders.edit` | yes | no | no | yes |
| Record an offline payment (creates, pays and fulfils the order) | `payments.record_offline` | yes | no | no | yes |
| Correct the billing of a paid order (credit note and new invoice) | `invoices.correct` | yes | no | no | yes |
| View orders, resend invoices, open invoice and credit-note PDFs | `orders.view`, `orders.resend_invoice` | yes | yes | yes | yes |

### Offline payments: the one exception to "licenses only from the webhook"

A paid order's licenses are otherwise issued only by the signature-verified payment webhook. An offline payment
record (`POST /api/admin/orders/offline`, `lib/admin/orders/offline.ts`) is the single documented exception:

- **Who:** Owner and Finance only (`payments.record_offline`), with a reason of 4-500 characters checked before
  anything else. Finance should check the UTR or cheque against the bank statement before recording it.
- **What:** the order is priced on the server exactly like checkout; the amount entered must **equal** that total (no
  partial payments); UPI, bank transfers and cheques need a reference; the received date must be within the last 180
  IST days and not in the future.
- **How:** ONE transaction creates the order and an offline `Payment` (provider `offline`, never sent to or reconciled
  with a provider), locks the order row and runs `fulfilPaidOrder()` (`lib/payments/fulfilment.ts`), the same code the
  webhook runs: licenses with HMAC + AES-GCM keys, terms snapshots, the gap-free invoice number, coupon redemption and
  the customer emails (never a full key). Any fulfilment error rolls everything back (409 `fulfilment_failed`).
- **Exactly once:** the console's `requestId` is stored unique on the order; a repeat by the same staff member returns
  the first order and stores nothing, a concurrent repeat is answered the same way (also when it failed on the limited
  coupon slot the first one used, so staff are never told "coupon used up" for a payment that was recorded), and
  another staff member's repeat is refused (409). A deadlock or lock timeout answers 503 `try_again` with nothing
  stored. Fulfilment takes its locks in one order everywhere (order, coupon, license counter, invoice counter), so an
  offline payment and a webhook sharing a coupon do not deadlock.
- **Audit:** one "Recorded offline payment" row naming the method, reference, amount, received date, invoice number
  and license count, plus the reason. Refunds of offline payments are not available in the console in this release.

Other order safeguards: a payment-link order has no payment attempt until the customer accepts the terms and pays
through the existing retry path (staff never accept terms for the customer); editing an unpaid order closes and stamps
its open payment attempts so an old provider checkout can never pay the old amount (a late capture goes to REVIEW);
a staff cancel is final for the customer; a billing correction cannot change the place of supply, the email or the
amounts, so the GST split stays the same, and it is refused while a refund exists or when the seller's state or GSTIN in
Settings no longer matches the original invoice (a credit note must come from the registration that issued the invoice
it cancels). A late `payment.failed` for an attempt a staff edit or cancel replaced is recorded on the attempt only: the
order keeps its status and no "try again" email goes out.

## Branding uploads (Admin > Settings > Branding, 2026-10-08)

The Owner can upload a logo for light backgrounds, a logo for dark backgrounds and a favicon (decisions.md "Branding:
logos and favicon"). They are public files served by the app from PostgreSQL (`BrandAsset`), so every upload is
treated as hostile:

- **Who and how.** `PUT` / `DELETE /api/admin/settings/branding/:slot` are adminRoute handlers: `settings.manage`
  (Owner) checked on the server, CSRF token and same origin, cross-site requests refused. The body is the raw file
  (`application/octet-stream` or `image/*`, else 415). A `Content-Length` over the slot's limit (1 MB logos, 256 KB
  favicon) is refused before anything is read, and the body is counted while streaming, so a missing or false length
  gets no further. 30 uploads per hour per Owner (`brandUpload`, counted before the body is read).
- **Type from the bytes.** `lib/branding/sniff.ts` reads the magic numbers; the declared type and the file name are
  ignored. Logos accept PNG, SVG and WebP, the favicon PNG, SVG and ICO; JPEG, GIF, BMP, TIFF, HEIF, PDF and anything
  unrecognised are 422 with a field error.
- **Rasters are re-encoded.** PNG and WebP go through sharp with a pixel limit (5000 x 5000) and `failOn: "error"`,
  are auto-rotated and re-encoded in their own format (WebP lossless). Every metadata chunk (EXIF, XMP, text, ICC
  names) is dropped, transparency is kept, animations keep their first frame. Minimum and maximum sizes and the square
  favicon are checked on the decoded size.
- **ICO is validated and rebuilt.** Header, directory, every image inside the file, each a PNG (its own IHDR) or a
  BITMAPINFOHEADER BMP, square, at most 1024 px, at most 64 x 256 x 256 px in all. The stored file is a new ICO made
  from those images only: PNG images decoded and re-encoded by sharp (no text, EXIF or other metadata chunks), BMP
  images cut to the bytes their header says they need. Bytes between or after the images (an appended HTML or ZIP
  polyglot, hidden text) are dropped. Served as `image/x-icon` with nosniff.
- **SVG is rebuilt, never passed through.** `lib/branding/svg.ts` parses with a strict XML parser and writes a new
  document from an allowlist of elements and attributes. Refused (422, with the reason): a DOCTYPE or entity
  declaration (no entity expansion, no external entities), processing instructions such as `xml-stylesheet`, entities
  other than the five XML ones, `<script>` (any case, also inside dropped elements), `<foreignObject>`, `<image>`,
  `<feImage>`, `<iframe>`, `<embed>`, `<object>`, `<audio>`, `<video>`, `<canvas>`, `<handler>`, `<listener>`, any
  `on*` attribute, `javascript:` / `vbscript:` / `data:text/html` in any attribute (after decoding character references
  and removing whitespace), `href` / `xlink:href` / `src` that is not a local `#id`, `url()` that is not `url(#id)`,
  and CSS with `@import`, `image-set()` and similar, `src()`, `expression()`, `-moz-binding`, `behavior` or backslash
  escapes. The CSS checks run on `<style>`, `style` and every other attribute that is kept (presentation attributes
  such as `fill` or `filter` are CSS too; dropped editor attributes are still checked for `url()`), on the text as written: comments are not stripped first (a comment cannot join
  CSS tokens, while stripping them without parsing strings let `"/*"` hide a `url()`), so a `url(` or `@import`
  even inside a comment is refused. Every check is a linear scan (no backtracking regex), so a 1 MB SVG of
  unterminated `url(` is refused in milliseconds instead of stalling the process. Dropped:
  comments, editor metadata, animation elements, `data-*` and every attribute or element outside the allowlist.
- **Served sandboxed.** `GET /brand/:file` answers with the stored type, `X-Content-Type-Options: nosniff`,
  `Content-Disposition: inline` and `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`
  (`BRAND_ASSET_CSP`). middleware.ts sets that policy on every `/brand/*` response instead of a page policy: Next.js
  keeps a header set in middleware over the one the route returns, so relying on the route alone would leave an SVG
  opened directly under the static page policy. Pages show the files with `<img>`, where SVG never runs scripts
  anyway; the sandbox covers the file opened as a document.
- **Audit.** "Uploaded / Replaced / Removed branding image" rows name the slot, MIME type, byte size and the first 12
  hex characters of the SHA-256; the bytes are never logged or audited.

## Other controls (Phase 7 review)

- **Development routes.** `/api/dev/*` answers 404 for every method in production (`middleware.ts`); `/dev/*` pages
  404 through `app/dev/layout.tsx`; the handlers also refuse outside development. The mock payment provider, local
  storage driver, console email transport and fixture catalog are refused by `lib/env.ts` in production.
- **SSRF guard (Admin integrations).** The SMTP host and the storage endpoint are typed by the Owner (Amazon SES has
  only a region from a fixed list, never a host or endpoint), and the server
  also runs Redis on 127.0.0.1:6380 and other local services. In production (`lib/security/host-rules.ts`,
  `lib/security/net-guard.ts`): loopback, private (RFC 1918, CGNAT), link-local (incl. 169.254.169.254), unique-local,
  multicast, reserved and unspecified addresses are blocked, also inside IPv4-mapped, NAT64 and 6to4 IPv6 addresses;
  `localhost`, `.local`, `.internal`, single-label names and numeric shorthands (`127.1`) are refused; storage
  endpoints must be https with no user name, path, query or fragment. The rules apply three times: when saving (plus a
  DNS lookup: any blocked address or a name that does not exist refuses the save), when resolving the configuration,
  and when connecting (the S3 client's guarded DNS lookup; nodemailer's `getSocket` hook connects to the checked
  address while TLS still verifies the host name), which also closes DNS rebinding. `.invalid` names are refused in
  every environment; development allows local test servers (MinIO, Mailpit). Messages never echo the host or address.
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

Secrets have two homes:
- **The env file**: `.env.local` in development (written by `pnpm secrets`), `shared/.env.production` (mode 600, app
  user only; generated by `scripts/gen-prod-env.mjs`) on the server. Everything the app needs to start, plus the
  optional fallback for payments, email and storage. `lib/env.ts` refuses placeholders and reports problems by name
  only.
- **The database, encrypted**: the Razorpay key and webhook secrets, the SMTP password or the Amazon SES secret access
  key, and the storage secret access key saved in Admin > Settings > Integrations (`IntegrationSecret`; decisions.md
  "Admin-configurable integrations", "Amazon SES as a second email provider").
  AES-256-GCM with a fresh random 96-bit IV per write; the key is HKDF-SHA256 over `LICENSE_KEY_ENC_KEY` with its own
  info label (`axs:integration-secrets:v1`), so the license-key cipher key is never reused; the associated data
  (`axs:integration-secret:v1:<kind>:<field>`) binds each ciphertext to its integration and field
  (`lib/integrations/crypto.ts`). Any decryption failure (wrong key, tampering, a ciphertext copied to another field)
  fails closed: the integration is "Not configured" and the env file is not used instead. Non-secret settings (key id,
  host, bucket, access key ID) are plain JSON.

Who can change what: the env file only someone with server access; the Admin integrations only the Owner
(`integrations.manage`), with the password re-entered for every save, clear and remove, and every change and test
audited by field label. A saved Admin configuration wins over the env file for its integration as a whole.

A saved secret is write-only, also against the Owner: a save that changes where it would be sent (the email provider;
the SMTP host, port or security; the SES region; the storage endpoint) must enter every saved secret the new settings
use again (`lib/integrations/store.ts`, 422 "Enter it again: ..."), so nobody can point email at their own server,
keep the stored password and read it out with "Send test email". Switching the email provider deletes the other
provider's saved secret, so it can never come back unseen; the card says so under Provider and in the password dialog
before Save.

Amazon SES (email provider, 2026-10-08) talks to AWS's own endpoint for a region from a fixed list
(`SES_REGIONS`); there is no endpoint field, in Admin or in the env file, so the SES secret cannot be sent anywhere
else and there is no SSRF surface (the SMTP guard below stays). The server environment cannot move it either: the
client sets `ignoreConfiguredEndpointUrls`, so `AWS_ENDPOINT_URL`, `AWS_ENDPOINT_URL_SESV2` and `endpoint_url` in
`~/.aws/config` are ignored, and pins FIPS and dual-stack off (`tests/unit/email-ses-endpoint.test.ts` checks the
resolved host with the real SDK). The SESv2 client gets the keys explicitly, so it never reads the server's `AWS_*`
variables or `~/.aws` files for credentials. The IAM user behind the key should only be allowed `ses:SendEmail` and
`ses:SendRawEmail`, scoped to the sending identity in that region (the policy is in docs/go-live-checklist.md). AWS
error texts (they name the identity and account) are never shown or audited: the test maps them by name. An outbox row
that failed through SES keeps the redacted AWS message in its error text, like SMTP errors (it can hold an AWS account
ID or ARN, never a key).

Password managers are kept away from the integration forms (decisions.md, 2026-10-08 autofill): the browser filled the
Owner's saved Admin sign-in into "Key ID" / "Access key ID" and "Key secret" / "Secret access key", because Chrome
ignores `autocomplete="off"` on password inputs. Secret inputs therefore use `autocomplete="new-password"`, which
Chrome never fills with a saved password; identifier inputs (Key ID, access key IDs, SMTP username, bucket), the
read-only webhook URL and the selects use `autocomplete="off"`; every input and select carries the 1Password, LastPass,
Bitwarden and Dashlane ignore attributes (those managers then neither fill, save nor generate) and an id and name that
do not look like a sign-in field; the forms are `autocomplete="off"`. Chrome's own password manager ignores the
ignore attributes and treats a `new-password` input as a sign-up field: it may still offer "Suggest strong password" on
a secret input, or "Save password?" after a save (with the Key ID or access key ID as the username). Accepting would
copy that secret out of the encrypted store into the browser. The Owner declines with "No thanks" (not "Never", which
is per site and would also stop Chrome saving the Admin sign-in); a secret that was ever saved there is deleted from
Chrome and rotated (docs/go-live-checklist.md).

Secrets are never committed, never shown again after saving (Admin shows "set", the last 4 characters of secrets of
16+ characters, who changed it and when), never returned by an API, never emailed, never in an audit row and never
logged. Production keys are generated on the server, never copied from development (the dev signing key was rotated
once already, Phase 3).

| Secret | Protects | If it leaks |
|---|---|---|
| `SESSION_SECRET` | sign-in code and trusted-device HMACs | forged trusted-device cookies (the password is still needed); rotate |
| `CSRF_SECRET` | CSRF tokens | CSRF protection weakens to the same-origin check; rotate |
| `ORDER_TOKEN_SECRET` | guest order links | anyone can mint order links (view orders, one-time key reveal of undelivered keys); rotate |
| `CRON_SECRET` | `/api/cron/*` (also blocked at Nginx) | jobs can be triggered early (idempotent); rotate |
| `LICENSE_KEY_PEPPER`, `LICENSE_KEY_ENC_KEY` | key lookup and key encryption; `LICENSE_KEY_ENC_KEY` also derives the key of the saved integration secrets | with a database copy, every license key and every saved integration secret can be decrypted. Cannot be rotated once keys exist: treat a leak as a re-key project (re-encrypt, reissue, and re-enter the integration secrets in Admin) |
| `LICENSE_SIGNING_PRIVATE_KEY` | activation tokens | forged offline activations until apps ship a new public key |
| Razorpay key secret and webhook secret (Admin, or `PAYMENT_KEY_SECRET`, `PAYMENT_WEBHOOK_SECRET`) | Razorpay API and webhook signatures | refunds or forged "paid" events; regenerate in Razorpay at once and save the new values in Admin |
| Storage secret access key, SMTP password, Amazon SES secret access key (Admin, or `STORAGE_*`, `SMTP_PASSWORD`, `SES_SECRET_ACCESS_KEY`), database and Redis passwords | files, outgoing mail, data, rate limits | rotate at the provider (SES: a new access key for the IAM user, then delete the old one); integration values are replaced in Admin (no restart) |

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
   - A leaked secret: rotate it (deploy/README.md table). Razorpay keys: regenerate in the dashboard first, then save
     them in Admin > Settings > Integrations.
   - Integration settings changed by someone else (audit log: "Updated integration settings", "Removed integration
     settings"): contain the Owner account as above, save the right values again (or "Remove saved settings" to fall
     back to the server file), and rotate every credential that was saved while the account was misused.
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
