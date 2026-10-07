# Decisions and deviations from the handoff

The handoff in `../design_handoff_axiomatic/` remains the design and behaviour reference. This file records every
decision taken where the handoff was silent, contradictory, or out of date. Accepted with defaults on 2026-10-06.

## Stack pins (npm `latest` is unsafe today)
- next 15.5.27 (Next 16 is current; code follows 16-forward conventions: always `await` params/searchParams/cookies()/headers()).
- react 19.2.8, typescript 5.9.3 (TS 7 breaks typescript-eslint), eslint 9.39.5 (flat config, `eslint .` not `next lint`).
- tailwindcss 4.3.3. Tokens are authored ONCE in `lib/design/tokens.ts`, consumed by `tailwind.config.mts` (loaded with `@config`; `.mts` because package.json has no "type").
  shadcn semantic colours (primary, ring, border, input, muted, destructive...) are aliases of those tokens. Light theme only.
- prisma 7.10.0 + @prisma/adapter-pg (8.0 is a release candidate). Generator `prisma-client` -> `generated/prisma` (gitignored).
  Connection URL lives in `prisma.config.ts`, which loads `.env*` through `@next/env`.
- @tanstack/react-table 8.21.3 (v9 removed `useReactTable`). shadcn/ui on Radix (`radix-ui` package), not Base UI.
- vitest 4.1.11, zod 4, argon2 0.45 (argon2id), jose 6 (EdDSA).
- Package manager pnpm 11 (`pnpm-workspace.yaml` allowlists install scripts).
- Icons: Material Symbols Rounded (opsz 24, wght 400, FILL 0) from `@material-symbols/svg-400/rounded`, compiled into a
  generated typed map containing only the icons we use (`pnpm icons`). The 5.4 MB icon font is never shipped.
- Fonts: Manrope + JetBrains Mono via next/font/google with subsets latin + latin-ext (the rupee sign is in latin-ext).

## Environment
- Native PostgreSQL 17 on localhost:5432 (role `axiomatic`, databases `axiomatic` and `axiomatic_test`), not Docker.
- No local S3/SMTP: `STORAGE_DRIVER=local` serves HMAC-signed 10-minute URLs from the app (dev only);
  `EMAIL_TRANSPORT=console` prints emails to the server log. Real S3 and SMTP drivers exist and are selected by env.
- `pnpm secrets` writes `.env.local` with fresh secrets and an Ed25519 keypair. `lib/env.ts` refuses placeholders.

## Scale target (25 lakh licenses)
- Stateless app servers; sessions in Postgres; horizontal scaling behind a load balancer.
- `/api/v1/licenses/validate` is the hot path (millions of calls/day): signature check + one indexed lookup;
  `DeviceActivation.lastSeenAt` is written at most once per 12 h per device; routine validations are never written to
  LicenseEvent. Activation tokens are EdDSA JWTs the apps verify offline (7-day grace).
- Rate limits: Postgres buckets in dev; Redis (`REDIS_URL`) required in production.
- Downloads come straight from S3/CDN via presigned URLs, never streamed through the app.
- Background work (emails, reminders, reconciliation) runs outside the request path.
- Large append-only tables (LicenseEvent, AuditLog, WebhookDelivery, DownloadEvent) get monthly partitioning when needed.
- Phase 7 includes a load test of the activation/validation API at ~1,000 req/s.

## Business rules (answers to the Phase 1 questions; all defaults accepted)
1. **Guest licenses**: `License.accountId` is nullable. A paid guest order issues licenses with `accountId = null`.
   When a user verifies the order email, a claim transaction sets `accountId` on that email's unclaimed orders and
   their licenses, attaching them to the account where the user is OWNER. Account-scoped queries never return
   `accountId = null` rows. Guests reach their order through a signed order link (`ORDER_TOKEN_SECRET`, 30 days).
2. **Subscriptions** are prepaid periods (1 month / 1 year) renewed manually through the cart, like ANNUAL.
   `License.autoRenew` stays false. No mandates in v1; copy that promises automatic renewal is reworded.
3. **GST**: computed once on the order taxable value. `gst = round(taxable * rate / 100)`; intra-state (billing state
   == company state): `cgst = round(gst / 2)`, `sgst = gst - cgst`; inter-state: `igst = gst`. Order discount and GST
   are allocated to lines by largest remainder so lines always sum to the header. Rate 18%, SAC 997331 (settings).
   To be confirmed with the company CA.
4. **Invoice numbers**: `AXS/<FY>/<4-digit>` e.g. `AXS/26-27/1181`. FY = April-March in Asia/Kolkata, from `paidAt`.
   Gap-free per FY via `Counter("invoice:<FY>")`, allocated inside the payment transaction. Seed continues at 1181.
   Prefix base (`AXS`) is editable (<= 3 chars [A-Z0-9-]); the next number is read-only. Credit notes `AXC/<FY>/<4-digit>`.
   GST (CGST Rules 46(b), 53) caps the number at 16 characters: `AXS/26-27/` leaves 6 digits, i.e. 999,999 documents
   per FY (a 2-char prefix allows 9,999,999). `lib/counters.ts` never returns a longer number: it throws
   `DocumentSeriesExhaustedError` (payment transaction rolls back, order goes to REVIEW) and logs
   `document_series_near_capacity` at 80/90/95/99% of the year's capacity. Running numbers above 9999 grow a digit,
   so lists sort by issue date or `compareDocumentNumbers()`, never by the number string.
5. **Terms** (base is always `Order.paidAt`, never wall-clock time inside retries):
   ANNUAL +365 days; SUBSCRIPTION +1 calendar month/year; ONE_TIME `expiresAt = null`, `updatesUntil = +updatesMonths`
   (default 12) calendar months; TRIAL `+trialDays` days; RENEWAL adds one interval from `max(paidAt, expiresAt)`;
   MAINTENANCE (a RENEWAL item whose plan type is MAINTENANCE) moves only `updatesUntil` by 12 months from
   `max(paidAt, updatesUntil)`. Calendar arithmetic is done in IST and clamps to month end. Dates display in IST.
6. **Trial -> paid** is an UPGRADE of the trial license: same key, devices and data; status TRIAL -> ACTIVE; new plan
   terms. Trials need a verified email; one per product per account (409 `trial_used`).
7. **Staff permissions** (`lib/rbac.ts` is the only source): the handoff PERMS map plus
   `customers.manage` (owner, admin, support), `payments.replay` (owner, admin, finance),
   `orders.resend_invoice` (all staff), `renewals.remind` (owner, admin, support).
   Every CSV export requires `reports.export` (audit export requires `audit.view`) and is itself audited.
8. **Customer team roles** follow the portal matrix (TEAM_PERMS in `lib/rbac.ts`): Technical can view invoices;
   only Owner and Billing can buy/renew/upgrade; Viewer can read tickets but not create/reply;
   the activity log is Owner-only.
9. **Seed logins** (dev only, refused in production): `SEED_OWNER_EMAIL/PASSWORD` is the real Owner;
   Priya (customer), Vikram (admin), Sneha (support), Karan (finance) share `SEED_DEMO_PASSWORD`.
   Other sample customers and the sample owner "Anita Desai" cannot sign in. Sample content stays labelled sample.
10. **Guest order page**: the full key is returned once (while `License.keyDeliveredAt` is null, `Cache-Control:
    no-store`), then masked; later reveals need an account and password. Guests may download through the order link
    with the same entitlement checks.
11. **Refunds**: the admin UI does full refunds. Refunding a RENEWAL/ADDON/MAINTENANCE item reverses that effect;
    only licenses the refunded order issued (NEW items) are revoked.
    **Open (blocks the refund route):** reversal needs the license terms before and after each fulfilled item, which
    cannot be rebuilt by subtraction (late renewals start at paidAt, month-end clamping, stacked renewals, the
    previous planId). Requested schema change: `OrderItem.termsBefore Json?` and `OrderItem.termsAfter Json?`
    (`{ planId, status, expiresAt, updatesUntil, deviceLimit }`), written by fulfilment; `reverseOrderItemEffects()`
    then restores `termsBefore` in reverse item order when the license still matches `termsAfter` (otherwise REVIEW).
    Proposed for a refunded trial -> paid UPGRADE: restore the trial terms (status TRIAL, trial plan and dates), so an
    ended trial reads as expired rather than revoked. To be confirmed.
12. **Two-step sign-in** uses an emailed 6-digit code (not TOTP).
13. **Hosting**: recommended AWS Mumbai (managed Postgres, Redis, S3 + CloudFront, containers). Decide before Phase 3.
14. **Seller details** stay placeholders in the seed; real legal name/GSTIN/address are entered in Admin > Settings.
    Each Invoice stores a snapshot of the seller details so later edits never change past invoices.

## Other assumptions
- Portal routes live under `/account/...` (the README's `/software` collides with the catalog).
- "Licenses only in the webhook" applies to paid licenses. Trials and staff manual issue go through the same
  `issueLicense()` on separately audited paths; checkout and the payment return can never reach it.
- License keys: `<CODE>-XXXX-XXXX-XXXX-XXXX`, alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` drawn with
  `crypto.randomInt`. Stored as HMAC-SHA256 (pepper) + AES-256-GCM ciphertext (`v1.<iv>.<tag>.<ct>`, base64url) +
  last 4. The sample key `GST-TRIA-...` contains `I`, which the format bans, so the seed replaces it.
- `Product.code` must match `^[A-Z]{3}$` and is immutable once licenses exist.
- Webhooks: `WebhookEvent` (PK provider + event id) is inserted only for signature-valid events inside the order
  transaction; every delivery (duplicates, bad signatures, replays) goes to `WebhookDelivery`.
- Counters (`Counter` table) allocate `AX-` order ids, `LIC-` license ids, `T-` ticket ids, invoice and credit-note
  numbers with a single atomic `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` inside the caller's transaction.
- Product FAQs live in `Faq(page = <product slug>)`, not `Product.content`.
- Validation errors return 422; Zod objects are strict (unknown keys rejected).
- Password policy everywhere: at least 8 characters with a letter and a number.
  Copy: "Use at least 8 characters with letters and a number."
- "Expiring" = within 60 days (`EXPIRING_DAYS`). Self-service device deactivations: 3 per license per calendar year (IST).
- Download link TTL = min(setting, `DOWNLOAD_LINK_TTL_SECONDS`, 600 s). Key reveal always requires the password.
- Cart is client state (localStorage) and the server always re-prices. NEW lines on non-per-unit plans are qty 1.
- No dark theme. Two prototype greys that fail contrast (#9AA3B2 text, #B4BCC9 icons) are darkened in the tokens.
  Unchecked checkbox/radio borders and the switch off-track use `line.control` (#7C8597, 3.7:1; WCAG 1.4.11) instead
  of `line.input` (#CBD2DF, 1.5:1).
- Custom breakpoints are in rem (cards 47.5, catalog 56.25, nav 60, portal 62.5, admin 65rem = 760-1040px), because
  Tailwind only orders breakpoints of the same unit. Control focus styles are utilities, not `@layer components`.
- GSTIN validation is format + state-code consistency (prefix must match the billing state). No checksum check,
  because the sample GSTINs are not checksum-valid.
- No e-invoicing (IRN/QR) in v1.

## Module map (Phase 1)
| Module | Purpose |
|---|---|
| `lib/env.ts` | Zod-validated env; refuses placeholders; `mock` provider and `local` storage refused in production |
| `lib/db.ts` | Prisma client singleton with the pg adapter; honours `?schema=` for test isolation |
| `lib/money.ts`, `lib/dates.ts` | INR formatting (paise), IST dates, Indian financial years, calendar arithmetic |
| `lib/validation/*` | GSTIN, state codes, PIN, mobile, email, password, billing schemas |
| `lib/pricing.ts` | `quote()`, `gstSplit()`, coupon evaluation, largest-remainder allocation (pure) |
| `lib/licensing/*` | keys, crypto, terms, status, entitlement (pure); issue/fulfil/trial (DB); activation tokens |
| `lib/rbac.ts` | Staff PERMS, team TEAM_PERMS, admin module gates, destructive-action rules |
| `lib/auth/*` | argon2id passwords, tokens, sessions, cookies, CSRF, rate limits, guards |
| `lib/counters.ts`, `lib/audit.ts`, `lib/log.ts`, `lib/http.ts` | ids/numbers, append-only audit, redacting logger, API errors |
| `lib/payments/*` | `PaymentProvider` interface, MockProvider (Razorpay adapter in Phase 3) |
| `lib/storage/*` | S3 driver + local dev driver behind one interface |
| `lib/config.ts` | Typed `SiteSetting` reader with defaults and env bounds |
| `lib/catalog/content.ts` | `productContentSchema` (shape of `Product.content`), shared by seed, storefront and admin |

Current module map (this table is the Phase 1 state): `docs/architecture.md` "Modules in `lib/`".

## Phase 1 build decisions (recorded at integration, 2026-10-06)
Licensing rules (`lib/licensing/*`):
- A license is expired when `expiresAt <= now`. Updates are active while `now < updatesUntil`; a release is covered
  when `releasedAt <= updatesUntil`.
- Download denials (`403 not_entitled`, `reason`): `revoked`, `suspended`, `expired`, `updates_ended`, `not_released`,
  plus `no_license` when the account holds no license for the product.
- ANNUAL/SUBSCRIPTION renewal of a perpetual license is refused (`not_renewable`); perpetual licenses renew through
  MAINTENANCE. ANNUAL/SUBSCRIPTION renewals switch `License.planId` to the renewal plan; MAINTENANCE keeps the plan.
- Item kinds per plan type (`ITEM_KIND_PLAN_TYPES` in `lib/pricing.ts`, enforced by `quote()` with 422
  `invalid_item_kind`): NEW -> ONE_TIME/ANNUAL/SUBSCRIPTION; RENEWAL -> ANNUAL/SUBSCRIPTION/MAINTENANCE;
  ADDON -> DEVICE_ADDON; UPGRADE -> ONE_TIME/ANNUAL/SUBSCRIPTION. Archived plans cannot be bought, upgraded to or
  added on, but RENEWAL lines on them are priced (prototype: "Existing licenses keep working and can still renew").
  The checkout still checks the target license (account, product, status, trial vs paid) before creating the order.
- MAINTENANCE renews perpetual licenses only (`not_renewable` when the license has an end date).
- Guest orders cannot carry RENEWAL, ADDON or UPGRADE items. RENEWAL or ADDON on a TRIAL license is refused
  (trials convert through UPGRADE). `OrderItem.fulfilledAt = Order.paidAt`. Fulfilment errors roll back the payment
  transaction; the webhook then marks the order REVIEW in a second transaction.
- Trials need a PUBLISHED product with a live trial plan. A trial counts as used when the account has any license
  that was a trial for the product (so an upgraded trial still counts). New copy: "Verify your email to start a free
  trial." (403 `email_unverified`) and "This product doesn’t offer a free trial." (422 `trial_unavailable`).
- `LicenseEvent.type` also uses `trial_ended` for expired trials (add it to the schema comment list on the next
  schema change).

Admin and auth:
- Every destructive action in `DESTRUCTIVE_ACTIONS` requires a reason, including coupon and FAQ deletes (stricter
  than the prototype). Reasons are at most 500 characters.
- Staff routes require `staffStatus = ACTIVE` (invited staff cannot act until they accept).
- `PAYMENT_WEBHOOK_SECRET` is required for every provider, the mock included: webhook signatures are always verified.
- Rate limits: the Postgres store is for development. Production needs a Redis `RateLimitStore` (not built yet;
  needs a Redis client package; `consume()` must be one Lua script).
- Limits that guard a secret check (sign-in, key reveal) count the attempt before verifying: `enforceAttempts()`
  (atomic consume, refused attempts not counted), then `clear()` the per-identity bucket and `refund()` the per-IP
  one on success. Never peek-then-count: concurrent requests would all pass the peek.
- Client IP: `TRUSTED_PROXY_HOPS` = proxies that append to X-Forwarded-For (ALB = 1, CloudFront + ALB = 2); required
  and >= 1 in production. `clientIp()` takes the entry that many places from the right and never trusts X-Real-IP;
  with 0 (dev default) it returns null. The origin must accept traffic only from the proxy chain.

Storage and data:
- Presigned upload and download URLs never live longer than 600 s (both drivers).
- Seed invoice numbering: the current FY ends at 1180 so real invoices continue at 1181; earlier FYs keep the
  prototype portal numbers (AX-10198 = AXS/25-26/1104, AX-10102 = AXS/24-25/0988).

Tooling:
- `lib/db.ts` turns `?schema=` into both the adapter schema and the session `search_path`, so raw SQL (counters,
  rate limits, `SELECT ... FOR UPDATE`) runs in the same isolated test schema as Prisma's model queries.
- `next.config.ts` carries a guarded fix for Windows exFAT volumes (wrong errno from `readlink`/`readFile`), which
  otherwise breaks `next build`. It only activates after a probe detects that filesystem.
- Vitest config is `vitest.config.mts` and resolves the `@/` alias with Vite's built-in `resolve.tsconfigPaths`.
- Client code reads the CSRF cookie/header names from `lib/auth/csrf-names.ts` (`lib/auth/csrf.ts` is server-only).
- Refund reversal data: for RENEWAL/ADDON/UPGRADE items, fulfilment stores the target license's terms in
  `OrderItem.termsBefore` and `termsAfter` ({ planId, status, expiresAt, updatesUntil, deviceLimit }, migration
  `20261006120000_order_item_terms_snapshots`). A refund restores `termsBefore` only while the license still matches
  `termsAfter`; otherwise the order goes to REVIEW. Open question for the owner: refunding a trial-to-paid upgrade
  would restore the (expired) trial terms.
- Design tokens: `line.control` (#7C8597, 3.7:1 on white) outlines unchecked checkboxes, radios and switch tracks
  (WCAG 1.4.11). Custom breakpoints are in rem so they order correctly with Tailwind's built-in ones.

## Phase 2 storefront decisions (2026-10-07, defaults accepted by "start Phase 2")
- Data: storefront pages read through `lib/storefront/data.ts` (server-only, cached with tags `catalog`, `faqs`,
  `settings` so admin edits can revalidate). `CATALOG_SOURCE=fixtures` (dev/test only, refused in production) serves
  the same sample data from `prisma/seed-data` when no database is available. Cached values use ISO date strings.
- Price display: every price renders both variants; `<html data-price="excl|incl">` picks one with CSS. A tiny inline
  script sets the attribute from the `axs_price_incl` cookie before paint, so pages stay static with no flash.
  Default = `SiteSetting tax.priceDisplay`. Incl. GST prices show exact paise everywhere (e.g. Rs 5,898.82).
- Cart is client state (`localStorage` key `axiomatic.cart`), badge rendered after mount. Compare selection (max 3)
  is client state plus the URL `/compare?ids=a,b,c` (noindex). Catalog filters live in the URL (`/software?q=&category=
  &price=&os=&license=&sort=`), filtered client-side (small catalog); canonical is `/software`.
- Sample strip renders when `content.sampleNotice.enabled`; `content.banner` renders under the header when enabled.
- Hero announcement is derived from the newest published release ("{Product} {major.minor} is out").
- Featured products on Home = all published products by rank. "Newest first" = latest release date.
- Product screenshots are HTML-rendered placeholder panels (code content per product) until real images exist.
- HIDDEN and DRAFT products return 404. Archived plans are not shown. Device add-on / maintenance prices show in
  "Add-ons for existing licenses" and link to the portal (`/account/licenses`).
- Trial CTA -> `/register?next=/account/software&trial=<slug>` (Phase 3 completes it). Demo CTA -> `/contact?type=demo
  &product=<slug>` (`#demo` is also honoured). Sign in -> `/sign-in`. Cart -> `/cart` (Phase 3).
- Toasts: product add-to-cart toast follows the product prototype (bottom-right, "View cart" / "Keep browsing", 6 s);
  other storefront toasts follow the README (bottom-center, ~3.2 s).
- Contact/demo requests are stored as `Lead` (ids `DEMO-1001` / `MSG-1001` from Counter "lead"), protected by a
  honeypot field, a 5/hour/IP rate limit and CSRF. The marketing opt-in is unticked by default (DPDP); contacting the
  person about their own request needs no extra consent. Acknowledgement emails arrive with the email module (Phase 3).
  Admin inbox for leads: Phase 6 (`leads.view` for owner/admin/support).
- Business settings gain `salesEmail`, `legalEmail`, `privacyEmail` and a postal address (sample placeholders).
- Docs, legal and long-form marketing copy are code content in `content/` (versioned with the code). Legal pages are
  marked "Sample - to be reviewed by counsel" with a version and date. Support FAQs are `Faq(page = "support")` with an
  optional guide link (`Faq.href`). `/docs` redirects to the first guide; `/legal` to `/legal/terms`; unknown slugs 404.
- SEO: per-page metadata with canonical URLs and OpenGraph; generated OG images (next/og); JSON-LD Organization
  (home, about), SoftwareApplication with one Offer per purchasable plan in INR (`priceSpecification
  .valueAddedTaxIncluded = false`), BreadcrumbList on product pages, FAQPage on pricing and support.
  robots.txt disallows /account, /admin, /api, /dev, /cart, /checkout, /orders, /compare.
- Copy fixes vs the prototype: install steps say "Software & downloads" (the portal label); subscription copy says
  renewals are manual (decision 2); "Not offered" / "Not included" marks use the darker contrast-safe tokens.

## Phase 2 build decisions (recorded at integration, 2026-10-07)
Layout and rendering:
- `Container` is border-box: `max-w-store` (1240px) includes the 24px side padding (16px below 640px), i.e. 1192px of
  content with the logo at x=44 in a 1280px window. Every composed prototype page sets `*{box-sizing:border-box}`.
- The catalog lives in the route group `app/(store)/software/(catalog)/`, so its `loading.tsx` does not wrap
  `/software/[slug]` (a streamed boundary would turn a product's `notFound()` into a 200). Known Next 15 limitation:
  `notFound()` thrown by a page answers 404 with an empty error shell (`<html id="__next_error__">`) and the product
  not-found UI renders on the client. `dynamicParams = false` would give full HTML but hide products added after a build.
- Static/SSG: `/`, `/pricing`, `/about`, `/support`, `/docs/[slug]`, `/legal/[doc]`, `/software/[slug]` and its share
  image (`revalidate = 300`, `Cache-Control` 300 s instead of ImageResponse's one-year immutable default), sitemap,
  robots, `/opengraph-image`. Dynamic by design: `/software` (server-renders the URL filters), `/compare` (selected
  ids, noindex), `/contact` (`?type=demo` without a flash), `/api/*`. With `CATALOG_SOURCE=db` the data layer's
  `unstable_cache` (300 s, tags) makes the static pages ISR, so `revalidateTag()` reaches them.
- A production build prerenders from the catalog, so it needs a reachable database and a production-valid env
  (`lib/env.ts` refuses fixtures, mock payments, local storage, console email and http `APP_URL` in production).
- Title template `%s — Axiomatic Software Solutions` (prototype em dash).
- Inline scripts we author: the price-display script (static, every page), the banner script (only while
  `content.banner` is enabled; it embeds the banner text with `<` escaped) and JSON-LD (escapes `<`, `>`, `&`,
  U+2028/U+2029). Next adds its own flight-data scripts, plus React's streaming scripts on dynamic routes.
- Tailwind: arbitrary breakpoints are written in rem (`min-[26.25rem]:`), because px values sort after the named rem
  breakpoints. `@source not inline("container")` keeps Tailwind's unused `.container` utility out of the CSS.
  `cn()` knows `max-w-store|portal|admin`, so `max-w-[880px]` overrides them.

Price display, cart and compare:
- `<html data-price>` also drives the PriceToggle's pressed look through CSS, so it is right before hydration;
  `components/store/price-toggle.tsx` is the client part, re-exported by `components/store/price.tsx`.
- Cart storage: `{ v: 1, items: [{ planId, qty, maxQty, kind, targetLicenseId }] }` (the prototype's bare array is also
  read). `apiFetch` retries once with a fresh token after `403 csrf_failed`.
- Catalog URL: comma-separated lists (repeated parameters also accepted); price keys `under-3000|3000-7000|over-7000`;
  the prototype's sort values; defaults are left out; search updates the URL after 300 ms. The compare-limit toast is
  bottom-center, lifted above the compare tray. `/compare` without ids shows the saved selection, else the first two
  products by rank; `?ids=` is written into the compare store and unknown or unpublished ids are pruned.

Pages and copy:
- Product page copy lives in `components/store/product/copy.ts`. The policy card adds the manual-renewal sentence;
  support hours and download-link minutes come from settings; sample notes show only while `business.sample`.
  Scroll-spy sets `aria-current="location"` once the in-page nav is stuck. Re-adding a capped line says
  "Already in your cart". Share images write "Rs" (next/og's built-in font has no rupee glyph).
- Pricing adds a "Ways to pay" / "Refunds" card. The GST example uses the cheapest paid ANNUAL plan of the top-ranked
  product that has one, priced with `quote()`. The matrix's sample note shows only while the sample notice is on.
  Organization JSON-LD uses the brand name while `business.sample` is true, `legalName` afterwards.
- Contact: a notice replaces the pre-ticked consent; the marketing opt-in is unticked. Stored keys: countersBand
  `1|2-3|4-10|10+`, preferredSlot `morning|afternoon|evening`, topic `sales|licensing|partnership|press|other`.
  Preferred date: today to +180 days (IST), Sundays allowed. The honeypot gets the same 200 `{ reference }` as a real
  request. 503 and 429 messages point to the sales email.
- Docs and legal: numbers in guide copy come from settings/env/plans (download TTL rounded down to minutes, self-service
  resets, offline grace, one-time update months, file-name chips from the newest releases). Legal values from settings
  are unbracketed; values counsel must set stay in [brackets]; the seller is the brand while `business.sample`. The
  refund policy no longer mentions cancelling subscriptions. `/docs` and `/legal` redirect with 307.
- Seed: `prisma/seed-data/plan.ts` writes `Category.blurb`, `Faq.href` and the `support` FAQ set.

Verification: `node scripts/check-storefront.mjs [--base=URL]` crawls every storefront route at 1280 and 360px (status,
console errors, one h1 and one main, title, JSON-LD, no horizontal overflow on phones, axe WCAG 2.0 A/AA + 2.1 AA).
Links to routes later phases build (`/cart`, `/sign-in`, `/register`, `/account/*`) are reported as pending.

## Phase 2 build decisions (recorded at integration, 2026-10-07)
- Storefront container: border-box, `max-w-store` (1240px) INCLUDING the 24px padding (16px below 640px), as in the
  composed prototype pages (`*{box-sizing:border-box}`), so content is 1192px wide and starts at x=44 at 1280px.
- The catalog lives in the route group `app/(store)/software/(catalog)` so its loading skeleton never wraps
  `/software/[slug]` (otherwise unknown products would stream a 200 instead of a 404).
- Headings no longer get a global `text-wrap: balance`; it is applied per heading where the prototype uses it.
- Contact form: preferred date from today to +180 days (IST), Sundays allowed; stored option values are stable keys;
  honeypot submissions get a decoy 200 response; the marketing opt-in is unticked and a short notice explains how
  the request will be used.
- Compare page adds "Scroll sideways to see every product." while the table overflows, and stacks the product
  selectors below 640px (accessibility deviations from the prototype).
- Icons stay true Material Symbols wght 400 SVGs. The prototype looks heavier in bold contexts only because the browser
  synthesises bold on the icon font.
- Docs copy corrections (decision 10 and daily license checks): revealing a key asks for the account password; a
  renewed license unlocks the next time the app checks its license, not "within a minute".
- A production build prerenders the storefront from the catalog, so it needs a reachable database
  (`CATALOG_SOURCE=db`) and a production-valid environment. `CATALOG_SOURCE=fixtures` is refused in production.
- Later phases: Phase 6 admin writes must call `revalidateTag(STOREFRONT_TAGS.*)`; Phase 3 adds the lead
  acknowledgement email and the /cart, /checkout, /sign-in and /register routes (links to them already exist).

## Development database (2026-10-07)
- The `axiomatic` login on the native PostgreSQL 17 (5432) was still missing, so development uses `pnpm db:dev`:
  an embedded PostgreSQL 17 (dev dependency `embedded-postgres`) on 127.0.0.1:5433, UTF-8, data in `.pgdata/`.
  Switching to the native server later only needs `DATABASE_URL` / `TEST_DATABASE_URL` changes plus
  `pnpm db:deploy && pnpm db:seed`.
- Databases must be UTF-8 (WIN1252, the Windows default, cannot store the rupee sign).
- DB tests load `.env.local` explicitly (`tests/support/load-env.ts`), because Next skips it when NODE_ENV=test.
- Verified 2026-10-07: migrations apply cleanly, the seed is idempotent (identical counts on repeat runs), all DB
  tests pass, the storefront renders from the database, and a production build prerenders from it.

## Phase 3 decisions: auth and purchase (2026-10-07, defaults; the owner asked for phases to run without stops)
Auth
- One `/sign-in` for customers and staff; after sign-in staff go to `/admin`, customers to `/account`, or to a safe
  relative `next` path. Middleware only does optimistic redirects of `/account/*` and `/admin/*` without a session
  cookie; every route still authorizes on the server.
- Register creates User + BusinessAccount (legalName = business name or the person's name) + OWNER membership, signs
  the user in and emails a 6-digit code (15 min, 5 attempts). Unverified users can verify, resend and sign out; the
  portal, trials and team actions require a verified email.
- Guest-order claim: on email verification, and on every sign-in of a verified user, orders with that email and
  `accountId = null` (and their licenses) move to the account where the user is OWNER.
- Two-step sign-in is an emailed 6-digit code (AuthToken LOGIN_OTP, 10 min, 5 attempts) required when
  `twoStepEnabled` and the device has no valid trusted-device cookie (`axs_td`, HMAC with SESSION_SECRET over user id,
  expiry and a password fingerprint, 30 days; any password change invalidates it).
- Forgot password always answers 200; the reset link token lives 30 min, single use; reset revokes all sessions and
  trusted devices and sends the user to sign in. Changing the password revokes the other sessions.
- Codes and reset links are emailed directly and never stored (only their hashes, in AuthToken).
Checkout and orders
- The cart stays client-side; `/api/checkout/quote` re-prices it on the server for display, `/api/checkout/orders`
  re-prices again and creates `Order(AWAITING_PAYMENT)` + `Payment(CREATED)` through the provider adapter.
- Guests can buy NEW items only. Renewal/add-on/upgrade lines need a signed-in member with the `purchases` team
  permission on the account that owns the target license.
- "Create an account" at checkout creates an unverified user + account that owns the order; the portal shows it after
  verification.
- Closing the provider checkout -> `POST /api/checkout/orders/:id/cancel` (CANCELED). "Try again" on a FAILED or
  CANCELED order creates a new payment attempt for the same order (back to AWAITING_PAYMENT); the cart is kept until
  the order is PAID.
- Order access: a signed-in member of the order's account (`invoices.view`), or the order link token (`?t=`, HMAC with
  ORDER_TOKEN_SECRET over order id + email + expiry, 30 days) included in the return URL and the order email.
- One-time key delivery: while `License.keyDeliveredAt` is null, the status response for the purchaser (the user who
  placed the order, or the order-link holder) includes the full key and sets `keyDeliveredAt`; responses are
  `Cache-Control: no-store`. Afterwards keys are masked; reveal needs an account and password (portal, Phase 5).
- The order page polls every 2 s for up to 2 minutes, then shows "Still confirming" with a manual refresh.
Payments
- Webhook processing follows api-contracts section 4 with decisions.md (WebhookEvent + WebhookDelivery, one
  transaction with the order row locked, amount + currency + provider order checks, invoice number, fulfilment,
  coupon redemption, audit, license events and outbox emails in the same transaction). A fulfilment error rolls back
  and a second transaction marks the order REVIEW with the reason.
- `payment.captured` after FAILED/CANCELED still marks the order PAID (the money was taken). `payment.failed` only
  fails the order when it concerns the latest attempt and the order is not PAID.
- Reconciliation (`/api/cron/reconcile`, Bearer CRON_SECRET, every 10 min) re-checks orders in CONFIRMING/PENDING and
  AWAITING_PAYMENT orders with a provider order older than 15 minutes, and applies captured payments through the same
  handler (event id `reconcile:<paymentId>`).
- Razorpay: REST via fetch (no SDK), Checkout.js modal, auto-capture assumed, signatures per Razorpay docs. CSP allows
  checkout.razorpay.com / api.razorpay.com. Verified live by the owner after Phase 7.
- MockProvider dev checkout at `/dev/mock-checkout` (dev only) simulates success, pending, failed and cancel and
  delivers signed webhooks to the real webhook route.
Email
- `lib/email`: console (dev; also kept in memory and listed at `/dev/mailbox`, dev only) and SMTP transports.
  Templates come from NotificationTemplate (`{{var}}`, HTML-escaped) inside a branded layout, with code defaults.
- Business emails (order confirmation, payment failed, license issued, lead acknowledgement, internal lead notice) go
  through the outbox in the triggering transaction and are sent after commit and by `/api/cron/emails`.
- Emails never contain full license keys: "License issued" links to the order page or the portal.
Invoice
- Tax invoice PDF at `/api/orders/:id/invoice.pdf` (same access as the order page), generated on demand with
  @react-pdf/renderer from the Invoice seller snapshot and the order lines (SAC, place of supply, CGST/SGST/IGST,
  amount in words). Fonts: Manrope + JetBrains Mono from @fontsource (latin + latin-ext so the rupee sign renders).

## Phase 3 build decisions (recorded at integration, 2026-10-07)
Auth (`lib/auth/flows/*`, `app/(auth)/*`, `components/auth/*`)
- Statuses the contract left open: verify-email after 5 wrong codes 429 "Too many attempts. Request a new code."
  (Retry-After = time until a resend is allowed); two-step after 5 wrong codes 429 "Too many attempts. Sign in again to
  get a new code."; an expired, unknown or superseded code or challenge 410 `code_expired`; a wrong current password
  422 `incorrect_password` (fieldErrors.current); an unknown or foreign session id 404.
- Contract supersets: register and verify-email accept an optional `next` (kept in the EMAIL_VERIFY token meta, so
  verification continues to e.g. `/account/software?trial=<slug>`); `GET /api/auth/reset-password?token=` answers
  `{ email }` | 422 | 410 (read-only) so /reset can say "For {email}"; `GET /api/auth/session` returns the `/api/me` body,
  or nulls with 200 when signed out (the header reads it after mount; `/api/me` would log a 401 on every anonymous
  page view). Unspecified bodies: `POST /api/me/password` `{ revokedSessions }`, `DELETE /api/me/sessions`
  `{ revoked }`, `DELETE /api/me/sessions/:id` `{ revoked, current, device }`, `GET /api/me/sessions` `{ sessions }` with a
  server-side device label ("Chrome on Windows").
- Secrets: two-step challenge ids and reset tokens are `<AuthToken id>.<256-bit secret>` with only SHA-256 of the
  secret stored; emailed codes are stored as HMAC(SESSION_SECRET) over purpose:userId:email:code.
- Invited and deactivated staff and password-less (sample) users get the generic 401 `invalid_credentials`.
- Forgot password: the per-email limit (3/h) is silent (200, no mail); only the per-IP limit (10/h) answers 429. The
  mail is sent without awaiting it (no timing signal); a new request voids older links. A successful reset also
  clears the per-email sign-in lock ("…or reset your password") and voids open reset links and two-step challenges.
- Two-step: the per-email attempt counted at the password step stays counted until the code succeeds (at most 5
  challenges per 15 min per email); code checks are also capped at 30 per 15 min per IP. An argon2 parameter rehash
  changes the hash and so invalidates that user's trusted devices (rare). The UI's "Resend code" re-posts the
  sign-in (it counts against the per-email limit, hence a 30 s cooldown).
- Sessions rotate on sign-in, two-step completion and email verification; a new `axs_csrf` cookie bound to the new
  session is set after every session change. A password change keeps the current session and revokes the others.
  An unverified customer who signs in goes to `/verify[?next=]` without a new code being sent.
- Customer security events go to the account activity log in the prototype wording ("Changed password", "Other
  sessions signed out", "Signed out all other sessions", "Signed out session"); staff get no entry.
- Copy: grammar fixes "1 attempt left." and "Try again in 1 minute"; new copy for undesigned states (expired codes,
  invalid/used/expired reset links, "That session has already ended.", the two-step step, the resend countdown, the
  password toggle "Show password", the header menu) awaits owner review. Prototype-only UI is gone (demo customer
  button, code hints, "accounts are stored in this browser"). `/forgot` stays on the page with the neutral notice.
  The aside headline is a `<p>` (one h1 per page). Signed-in visitors of /sign-in and /register are redirected; the
  signed-in banner stays on /forgot, /reset and /verify. The 409 `email_taken` banner links "Sign in instead.".
- `?email=` prefills /sign-in, /register and /forgot. The order page hands the order email to /register through
  sessionStorage `axiomatic.registerPrefill` (`{ v: 1, email }`, read once), never through the URL.

Email (`lib/email/*`)
- NotificationTemplate rows (admin-editable) supply the subject and body copy only. Code boxes, buttons, order details
  and small print are code blocks (`lib/email/defaults.ts`), so an admin edit can never drop a code or link. A draft
  (inactive) template falls back to the code default instead of suppressing the email (`license_expired` is a draft
  in the seed). Unknown `{{vars}}` stay visible in dev/test and are blanked in production (names logged).
- `enqueueEmail` is strict outside production (throws on auth templates, unknown templates, bad recipients, missing
  vars); in production it logs and skips (missing vars: logs and still enqueues), so a template problem never rolls
  back a payment transaction. `kickEmailDispatch()` is a no-op under NODE_ENV=test unless `setEmailAutoDispatch(true)`.
- Outbox delivery is at-least-once: SENDING rows whose 10-minute lease expired are claimed again; backoff 1/2/4/8 min,
  FAILED on the 5th failure. Dedupe keys: `order_confirmation:<orderId>`, `payment_failed:<orderId>:<paymentId>`,
  `license_issued:<licenseId>` (last 4 of the key only). Scheduler: `/api/cron/emails` every minute (Bearer CRON_SECRET).
- SMTP: pooled nodemailer (lazy-loaded), 10 s connect/greeting and 30 s socket timeouts, STARTTLS required in
  production unless port 465, `Auto-Submitted: auto-generated` and `X-Axs-Template` headers; `sendAuthEmail` times out
  after 15 s. Logs carry the template id, a masked recipient (`pr***@domain`) and ids, never subjects, bodies, codes or
  links; `OutboxEmail.lastError` is redacted and truncated.
- Leads: `createLead({ notify })` enqueues `lead_received` and `lead_new` in the lead transaction. `lead_new` carries the
  whole request; `lead_received` greets "there" when the name looks like a link or address and never echoes the message.
- `/dev/mailbox` (development only) keeps the full messages in memory; the console transport's log line points to it.

Checkout and orders (`lib/checkout/*`, `lib/orders/*`)
- A provider failure at order creation stores nothing and answers 502 `payment_unavailable`: the order id comes from
  its own short transaction, the provider is called outside any transaction, then Order + items + Payment(CREATED) are
  inserted together. Order ids may have gaps; invoice numbers never do.
- A coupon that no longer applies when the order is created answers 422 `validation_failed` with
  `fieldErrors.couponCode` (never silently dropped: the buyer would pay more than the total shown).
- Order access answers 404 (not 403) for orders the viewer may not see and for bad tokens; 403 `order_link_expired`
  only for a genuine expired link; 401 signed out without a token. Token `o1.<exp>.<emailTag>.<sig>`: the email is
  bound through an HMAC tag and never appears in the URL.
- `canRetry` is also true for AWAITING_PAYMENT ("Return to payment"), which reopens the open CREATED attempt. The
  payment return accepts a valid signature for any attempt of the order. Status responses never include a full key
  for cross-site requests (sec-fetch-site or a foreign Origin/Referer).
- Staff sessions can quote NEW items but cannot order (403 `staff_checkout`); members without `purchases` get 403 even
  for NEW-only carts; a signed-in customer with no business account buys like a guest (accountId null, placedByUserId
  set). `createAccount` is ignored when signed in; the account created at checkout gets the billing details and
  verification continues to `/orders/<id>`. `CHECKOUT_TERMS_VERSION` combines the terms, EULA and refund versions.
- Extra DTO fields (additive): quote issues carry `index`, `kind`, `targetLicenseId`; status items `productId`,
  `discountPaise`; licenses the derived lowercase `status`.

Payments (`lib/payments/*`, webhook and reconcile routes)
- `processPaymentEvent` finds the Payment by provider order id, locks the Order row (`SELECT ... FOR UPDATE`), then
  inserts WebhookEvent with ON CONFLICT DO NOTHING, so concurrent duplicates queue on the lock. Counters are always
  taken license -> invoice. `Invoice.issuedAt = Order.paidAt`; `paidAt` is the provider event time when not in the future.
- `payment.captured` for an order in REVIEW records the capture and leaves the order (`order_in_review`); a capture of
  a different payment after PAID marks that Payment CAPTURED and audits `payment.captured_twice` for a refund
  (`already_paid`). `refund.processed` for an unknown refund id changes nothing (`unknown_refund`). Extra result values:
  `order_in_review`, `stale_attempt`, `unknown_refund`, `fulfilment_failed`, `invalid_payload`, `ignored` (add them to
  the schema comment on the next schema change).
- Invalid-signature deliveries are recorded only up to 30 per 10 min per IP (`RATE_LIMITS.webhookInvalidIp`); beyond
  that they still get 401 but are not stored. Valid deliveries are never limited. The webhook route accepts only the
  configured `PAYMENT_PROVIDER` (other keys 404).
- `payment_failed` emails wait 5 minutes for real providers (0 for the mock) and are withdrawn when the order becomes
  PAID, so a customer who retries inside Razorpay's modal gets no stale failure email.
- Reconciliation bounds: CONFIRMING/PENDING attempts up to 7 days, AWAITING_PAYMENT up to 72 hours; events already
  recorded as `reconcile:<paymentId>` are skipped; refunded/authorized/created provider payments are left alone; an
  order fails only when every payment of its provider order failed. Scheduler: `/api/cron/reconcile` every 10 minutes.
- `NormalizedEvent.currency` is a string (to represent a mismatch) and gains `occurredAt`.
- Mock "Bank pending" returns no return payload: the mock route itself moves Payment + Order to PENDING, and the
  webhook comes only after `/api/dev/mock-checkout/bank` (the order page's "Test mode" box).

Cart, checkout, order page and invoice UI
- Checkout: the summary column minimum is 340px (the prototype's 360px never fits beside the form, so the prototype
  always stacks it); from about 1116px it is the README's right sticky summary, below that it stacks as prototyped.
  Prefill is done on the server (`loadCheckoutViewer`); staff and members without `purchases` see why up front.
  The error summary is the prototype's single alert line, focused on submit, with aria-invalid/aria-describedby on
  each field. CGST/SGST vs IGST is split on the client from the quote with the server's rule (no quote request per
  state change; coupon quotes are limited); the server re-prices at order creation. The GSTIN/billing-state check is
  live ("Valid format · <State>"). Sample coupon codes show only while `business.sample`. The create-account help
  reads "At least 8 characters with letters and a number". When Checkout.js cannot load, the saved order is linked:
  "We couldn’t open the payment page. Your order is saved, so you can pay for it from the order page." Closing the
  Razorpay modal cancels the attempt and lands on the order page ("Payment canceled" with "Return to payment").
- Cart: prices always excluding GST (prototype "Prices exclude GST."); device add-on lines read "N computers".
- Order page: the paid hero says the confirmation was emailed (emails never carry keys). Keys follow decision 10:
  shown once with Hide and Copy key, hidden after 60 s, masked afterwards with "Reveal in account" (Phase 5). New copy:
  "Still confirming your payment" + "Refresh status" after the 2-minute polling window, "Order refunded" / "Order
  partly refunded", "This order link has expired". Order not found renders inline with HTTP 200 (also for foreign
  orders and bad tokens). Summary amounts come from the order snapshot; license pills show the derived status.
  "Download invoice" downloads the PDF; the summary adds "Print invoice" and "Download PDF".
- Invoice PDF (`/api/orders/:id/invoice.pdf`): 409 `invoice_unavailable` before payment, 30 renders per 10 min per IP
  (`RATE_LIMITS.invoicePdfIp`). While the seller snapshot is sample data the PDF says it is not a valid tax invoice.
  `lib/invoice/pdf.tsx` uses `React.createElement` because Vitest compiles with `jsx: "preserve"`.

Integration (2026-10-07)
- Cart clearing has one mechanism: checkout records the ordered cart lines (localStorage `axiomatic.cartOrder`,
  `rememberCartOrder`) and the order page calls `clearCartForPaidOrder(orderId)` from `components/checkout/cart-order.ts`
  once the order is PAID, removing only those lines. (The order page's own sessionStorage `axiomatic.pendingOrder`
  hand-off, which checkout never wrote, was removed.)
- One Checkout.js launcher: the order page's "Try again" / "Return to payment" use `startHostedCheckout()` from
  `components/checkout/hosted-checkout.ts` (the duplicate `components/store/order/open-checkout.ts` was removed).
- The order page also re-checks an AWAITING_PAYMENT order for 15 s after it opens (silently, no timeout message):
  a failure is reported by webhook about a second after the provider page returns, so the first render could miss it
  and stay on "Waiting for payment" (seen with the mock "Payment fails" outcome).
- CSP: the Razorpay sources are sent only on `/checkout` and `/orders/:id` (`RAZORPAY_CSP_PATHS` in `next.config.ts`);
  every other page gets the baseline policy. A client-side navigation keeps the current document's CSP, so links INTO
  those pages from pages without Razorpay must be full page loads: the cart's "Continue to checkout" is a plain `<a>`,
  and later phases that link to `/orders/:id` (portal order history) must use `<a>`, not `next/link`.
- `/api/dev/*` answers 404 for every method in production (middleware), not only for POST (GET used to answer 405).
  `/dev/*` pages 404 through `app/dev/layout.tsx`.
- Rate-limit rules live in one place: `changePassword`, `loginCodeIp`, `orderIp`, `quoteIp`, `orderReturnIp`,
  `orderStatusIp`, `orderActionIp`, `invoicePdfIp` and `webhookInvalidIp` moved into `RATE_LIMITS` with the same keys,
  limits and windows (`tests/unit/rate-limit-rules.test.ts`).
- Cron auth is shared (`lib/auth/cron.ts`): `Authorization: Bearer <CRON_SECRET>` in constant time, 401 "Missing or
  invalid cron credentials." with `WWW-Authenticate: Bearer realm="cron"`. Cron and webhook routes have no CSRF check
  (no cookies); every other mutating route checks CSRF and the origin.
- The seed was re-run to add the `login_code`, `lead_received` and `lead_new` templates (idempotent; counters are never
  lowered).
- Verification: `node scripts/check-purchase.mjs` drives the purchase and auth journeys end to end (mock provider,
  codes from /dev/mailbox, database checks); `scripts/check-storefront.mjs` also crawls /cart, /checkout, the auth
  pages and /verify as a freshly registered customer.

Open items and follow-ups
- Phase 5: portal, trials and team actions must require a verified email; `lib/auth/guards.ts` needs a
  `requireVerifiedCustomer()` (or an option on `requireAccountRole()`), and `/account/*` pages must send unverified
  customers to `/verify?next=<path>`. `/account/software` must handle `?trial=<slug>` (register and verify continue
  there), `/account/licenses` gives the password-gated key reveal the order page links to.
- Phase 4: guest download through the order link (the order page shows a note until then).
- Phase 6: admin refunds create the Refund row (PENDING) with `providerRefundId` in the same request; webhook replay
  rebuilds the event from `WebhookEvent.payload` and calls `processPaymentEvent(provider, event, { replayedById })`.
  Admin Templates "Send test" can use `composeEmail(db, id, def.sampleVars, { content })`. The seeded `renewal_30`
  subject ("renews on") implies automatic renewal and must be reworded with the renewal work (decision 2).
- Production access logs: order links carry the order token in the query string (`?t=`, a 30-day credential for that
  order, also in the order emails). App logs redact it (`lib/log.ts`) and `next start` logs no requests, but proxy and
  CDN access logs (ALB, CloudFront) must drop or mask query strings. Phase 7: consider exchanging the link token for
  a short-lived cookie on first visit.
- Development: with `TRUSTED_PROXY_HOPS=0` every local request shares the "unknown" IP rate-limit buckets (5
  registrations per hour, 20 sign-in failures per 15 minutes, 20 orders per hour); `check-purchase.mjs` clears them on
  local servers before it runs.
- Tooling requests (locked files): `esbuild: { jsx: "automatic" }` in `vitest.config.mts` would let `.tsx` modules
  with JSX be imported by tests; an `output: "standalone"` build needs `outputFileTracingIncludes` for the
  `@fontsource/{manrope,jetbrains-mono}` latin/latin-ext woff files the invoice PDF reads at runtime.
- Owner review: new copy for undesigned auth and order-page states, email bodies, the payment-page-failed message.
  Razorpay is verified live by the owner after Phase 7.

Payment state rules (after the Phase 3 security/domain review):
- A verified return reopens a FAILED or CANCELED order as CONFIRMING and marks that attempt AUTHORIZED; the order
  page keeps polling FAILED/CANCELED orders for 15 s for that reason, and "Try again" answers 409 `not_retryable`
  while an attempt is confirming (the page then just refreshes).
- `payment.failed` is ignored when it concerns another payment of the same provider order, or while any attempt of
  the order is AUTHORIZED or CAPTURED; a CONFIRMING order fails only for the verified payment itself.
- `refund.processed` changes Order.status only when the refunded payment is the one that paid the order, and only
  from PAID or PARTIALLY_REFUNDED (refunding a duplicate capture never marks the paid order REFUNDED).
- Coupon limits hold under concurrency: creating or retrying an order locks the coupon row and counts holds
  (unpaid orders hold for 1 hour, in-flight payments for 7 days); a retry re-checks active/dates/limit.
- Reconciliation also covers AUTHORIZED attempts and recently closed orders on a thinning schedule.
- Transient database errors in the webhook transaction are retried (the provider redelivers) instead of sending the
  order to REVIEW.
- Auth hardening: forgot-password voids older reset links only when a new one is issued; verify-email allows 10 wrong
  codes per user per 24 h and 30 per IP per 15 min; person names reject links and email addresses ("Enter your name
  without links or email addresses."); all customer emails use the same greeting rule.
- Owner copy review: the new messages above plus "Too many attempts. Try again in N hours.".
- Dev signing keys were rotated on 2026-10-07 because part of the old dev private key appeared in an agent's
  tool output; production keys must always be generated fresh on the server.

## Phase 4 decisions: activation API and downloads (2026-10-07, defaults)
Activation API (`/api/v1/licenses/activate|validate|deactivate`, api-contracts section 6)
- Header `X-App-Id: <product code>` is required. JSON only. No cookies or CSRF (device API). Errors use the usual
  `{ error: { code, message } }` plus the contract fields (`devicesUsed`, `deviceLimit`, `manageUrl`).
- Lookup by HMAC of the normalised key. Malformed and unknown keys both answer 404 `invalid_key` (no enumeration).
  Status order: REVOKED 403 `license_revoked`, SUSPENDED 403 `license_suspended`, expired 403 `license_expired`,
  wrong product 422 `wrong_product`.
- Activation locks the license row (`SELECT ... FOR UPDATE`) so concurrent activations can never exceed the device
  limit. The same fingerprint already active answers 200 `already_active` with a fresh token (no extra slot).
- Activation token: EdDSA JWT `{ lic, fp, prod }`, `exp = now + LICENSE_OFFLINE_GRACE_DAYS` (7). `/validate` accepts
  tokens up to 30 days past expiry (a device that was offline longer must re-activate with its key), checks the
  device is still active and the license status, and returns a fresh token, `latestEligibleVersion` and
  `nextCheckBefore`. It writes `lastSeenAt`/`appVersion` at most once per 12 h per device and never writes
  LicenseEvent rows (scale target).
- `/deactivate` from the device itself frees the slot without counting toward the customer's 3-per-year limit.
- Rate limits: activation 10/min per key hash and 60/min per IP; validate and deactivate 30/min per license and
  60/min per IP.
Downloads and software
- `POST /api/account/downloads { releaseFileId }` (team permission `downloads`): the entitlement check picks the
  account's best license for the product; 403 `not_entitled` with `reason`; otherwise a presigned URL (min(setting,
  env, 600 s)), a DownloadEvent and an "Downloaded installer" activity entry.
- Guests download through `POST /api/orders/:id/downloads { releaseFileId, t }` using only licenses issued by that
  order; DownloadEvent.userId is `guest:<orderId>`.
- `GET /api/account/software`: per licensed product, the latest release, the newest release the account may
  download, and each release marked Included / Needs renewal.
- Dev storage: `GET /api/dev/storage/<key>?exp=&sig=` (dev only) streams from `.storage/`;
  `node scripts/storage-seed.mjs` writes small SAMPLE placeholder installers for the seeded release files (a
  `pnpm storage:seed` alias is requested from the integrator; package.json is locked for phase work).
Account license actions (APIs now; portal UI in Phase 5)
- Key reveal `POST /api/account/licenses/:id/reveal { password }` (team `keys.reveal`; password re-auth, 5 failures
  per 15 min, `key_revealed` event + activity, `{ key, hideAt }` with `hideAt = now + 60 s`, no-store; not for
  revoked licenses).
- Self-service device deactivation (team `devices.manage`): 3 per license per calendar year (IST); the 4th answers
  429 `reset_limit` with the portal copy. Device rename/location `PATCH /api/account/devices/:id`.
- Admin reset of devices (service now, admin UI in Phase 6) bypasses the limit, zeroes the counter and is audited.
Scale
- Rate limits use Redis when `REDIS_URL` is set (atomic Lua scripts, key prefix `axs:rl:`), registered at server
  start in `instrumentation.ts`; Postgres buckets remain the development fallback. `REDIS_URL` is required in
  production. Local tests use the Memurai server on 127.0.0.1:6379 when available.
- `scripts/bench-validate.mjs` measures `/validate` throughput locally; the Phase 7 load test targets ~1,000 req/s.

Phase 4 fix pass (review findings, 2026-10-07)
- Device limit: a renewal or upgrade that lowers `deviceLimit` (per-unit renewals set it to the quantity; a trial
  upgraded to a smaller plan) deactivates the active devices above the new limit inside fulfilment, under the License
  row lock, least recently seen first (lastSeenAt, then activatedAt): `deactivatedBy` "system", a `deactivated`
  LicenseEvent (actor "System", detail "<device> · over the new limit of N devices") and a "Deactivated device"
  activity entry each; never counted toward the yearly self-service limit. Their next /validate answers 403
  `device_deactivated`. Shared helper `trimDevicesToLimit()` (lib/licensing/device-limit.ts): Phase 6 admin edits of
  deviceLimit and the refund restore of `termsBefore` must call it too. /validate still never counts devices.
- Checkout refuses a per-unit RENEWAL or UPGRADE whose quantity is below the license's active devices: line issue
  `below_active_devices`, "This license has N active computers. Choose at least N terminals, or deactivate computers
  first." When the plan cannot sell that many (maxQty; add-ons can take a license past it): "This license has N active
  computers, more than the 10 terminals this plan allows. Deactivate computers first, or contact support." (owner copy
  review; per-unit renewals still drop add-on slots, an existing terms rule worth revisiting with the owner).
  Non-per-unit plans are not refused (the quantity does not set their limit).
- Activation churn: activations of new fingerprints per license are capped at max(3, 2 x deviceLimit) in any rolling
  30 days (rows created in the window, active or not; `already_active` is never counted): 429 `activation_churn`,
  "Too many computers were activated on this license recently. Contact support to activate another.", Retry-After =
  until the oldest counted activation leaves the window. Device-initiated /deactivate stays free and uncounted (the
  contract), but one slot can no longer be passed between machines that keep running offline on their tokens. Staff
  "Reset devices" does not clear the window; support waits it out, or Phase 6 adds an override if support needs one.
- Activation token: `exp` = min(now + LICENSE_OFFLINE_GRACE_DAYS, License.expiresAt) (at least iat + 1 s), for
  /activate and /validate, so `nextCheckBefore` never passes the end of an annual license or a trial. A refinement of
  the contract's "now + 7d"; the claims stay `{ lic, fp, prod }`.
- Token binding: `fp` is readable in the token payload, so a leaked token (support ticket, backup) lets its holder
  call /validate or /deactivate for that device (it still cannot unlock another computer offline). Kept as the
  contract defines it for now; the guide tells apps to treat the token as a secret. Owner decision requested: sign a
  hash (`fph = base64url(SHA-256("axs-fp-v1|" + fp))`) instead, before any app ships.
- Release order: the "latest" release is the highest version (semver precedence: numeric core, a release ranks above
  its pre-releases, build metadata ignored, 2-4 part versions allowed); the release date only breaks ties. One rule for
  latestEligibleRelease (/validate latestEligibleVersion, portal eligible release, order page) and
  compareReleasesNewestFirst (portal latest release, release lists): a 4.1.5 hotfix published after 4.2.0 is older.
- Release channel: customers see and download the `stable` channel only (`STABLE_CHANNEL` in
  lib/licensing/entitlement.ts): /validate, GET /api/account/software, the order page and both download endpoints
  (a file of another channel answers 403 `not_entitled` reason `not_released`). Beta programmes need a separate,
  labelled list later. The storefront product pages (Phase 2, lib/storefront/prisma-source.ts) still read every
  PUBLISHED release and should get the same filter.
- Portal device counts come from one grouped query for the listed licenses (`countActiveDevices`) or a relation
  filter for one account (`countActiveDevicesForAccount`); Prisma `_count` of devices is not used on lists
  (tests/db/portal-query-plans.test.ts checks the plans on 20,000 licenses).
- Database pool: `DATABASE_POOL_MAX` (10), `DATABASE_POOL_TIMEOUT_MS` (5000), `DATABASE_STATEMENT_TIMEOUT_MS` (5000,
  0 = server setting) in lib/db.ts and lib/env.ts. Pool waits, statement timeouts and lost connections answer 503
  `unavailable` with Retry-After 5 ("We can’t complete this request right now. Please try again in a moment.")
  instead of a logged 500, logged as `database_unavailable` at most once per 10 s per process.
- Rate limits: when the per-license limit of /validate or /deactivate refuses a request, the per-IP slot it took is
  refunded, as the developer guide promises ("refused requests are not counted").

## Phase 4 build decisions (recorded at integration, 2026-10-07)
- Lowering a license's device limit (a per-unit renewal with fewer terminals) deactivates the devices above the new
  limit, least recently seen first (deactivatedBy "system", with a license event); checkout refuses a per-unit
  quantity below the number of active computers ("below_active_devices").
- Activation churn cap: a new computer is refused with 429 `activation_churn` when the license already saw
  max(3, 2 x deviceLimit) activations in the last 30 days, so one slot cannot be rotated across unlimited machines
  with device-side deactivation.
- Activation tokens never outlive the license: `exp = min(now + grace, expiresAt)`.
- Validate, the portal and downloads offer the stable channel only; versions compare by semver precedence (date as the
  tie-break).
- Database pool bounds per process (DATABASE_POOL_MAX 10, DATABASE_POOL_TIMEOUT_MS 5000,
  DATABASE_STATEMENT_TIMEOUT_MS 5000); past either the API answers 503 instead of hanging.
- Redis rate limits fail CLOSED for secret checks (sign-in, key reveal, activation) when Redis is down (503), and are
  registered once at start-up in instrumentation.ts.
- Open owner decision: sign a fingerprint hash instead of the raw fingerprint in activation tokens (changes the
  api-contracts claims); current behaviour and its risk are documented in docs/activation-api.md.
- Open business rule: per-unit renewals set deviceLimit = quantity, which drops any device add-on slots.
- Phase 7 items: DeviceActivation fillfactor 90 + autovacuum tuning for the daily lastSeenAt updates; optional partial
  unique index on active (licenseId, fingerprint); Redis bucket reset in scripts/check-purchase.mjs when REDIS_URL is set.

## Phase 5 decisions: customer portal (2026-10-07, defaults)
- Routes: /account (overview), /account/software, /account/licenses, /account/licenses/[id]?tab=overview|devices|
  activity|renew, /account/devices, /account/orders, /account/billing, /account/team, /account/tickets,
  /account/tickets/new, /account/tickets/[id], /account/notifications, /account/activity, /account/security; team
  invitations are accepted at /invite?token=. Filters, sort and paging live in the URL.
- Access: the portal layout requires a signed-in, verified customer (unverified -> /verify?next=, staff -> /admin).
  Team-role gating follows TEAM_PERMS: owner-only pages (Team, Activity) are hidden from the nav for other roles and
  show a permission-denied panel by URL; actions a role lacks are disabled with a tooltip ("Requires Owner or
  Technical contact"); the API enforces the same rules.
- Business switcher: when a user belongs to several accounts it switches the server-side active account
  (`POST /api/me/active-account`). Locations are managed from Devices ("Manage locations": add, rename, delete;
  deleting moves its devices to "Unassigned"). New activations are unassigned.
- Team: owners invite by email (role Billing admin, Technical contact or Viewer; Owner can be granted later by an
  owner); invites expire after 7 days and can be resent or revoked; at least one active Owner must remain; you cannot
  change your own role or remove yourself; role changes and removals ask for confirmation (no reason). Invited emails
  without an account get a placeholder user (no password) until they accept; accepting from the email link verifies
  that email.
- Renew & upgrade: renewals and add-ons go to the cart with the target license (Owner/Billing only); trial -> paid is
  an UPGRADE of the trial license. Add-on device slots stay with the license through renewals of non-per-unit plans.
- Devices: self-service deactivation asks for confirmation (no password); a device not seen for 30 days is marked
  "Not seen recently". Android installers download like the other platforms when a release has an Android file.
- Security page: profile (name, phone), password change, 2-step on/off (turning it off needs the password), active
  sessions with "Sign out" and "Sign out all other sessions" (confirmation), data export (JSON of the account's
  licenses, devices, orders, invoices, tickets and activity; no keys). Sessions show browser/OS and the truncated IP
  (no GeoIP lookup).
- Notifications: per-user email preferences (renewals, updates, tickets, offers); turning offers on records the
  consent time (DPDP). In-app notifications are listed with "Mark all as read".
- Tickets: impact Low / Normal / High maps to priority; up to 5 attachments (PNG, JPEG, PDF, TXT, 10 MB each) via
  presigned upload; attachments download through 10-minute links for members who can view tickets; customers can
  reopen RESOLVED tickets; CLOSED tickets (staff, or 14 days after resolution) cannot be reopened (start a new one).
- Orders: "Invoice" downloads the PDF; a row opens the order page. The accountant CSV has the GST split per order.
  Spend by product uses order line snapshots (taxable + tax) of PAID and partially refunded orders, net of refunds.
- Activity log: Owner-only, 10 per page, filter by kind and search, CSV export; entries record the actor.
- Dev data: Rohan Sharma (Billing admin) and Kavya Desai (Technical contact) become demo logins with
  SEED_DEMO_PASSWORD so role-based portal behaviour can be checked locally.

## Phase 5 build decisions (recorded at integration, 2026-10-07)
Shell, navigation and access (`app/account/layout.tsx`, `components/account/*`, `lib/portal/context.ts`)
- `getPortalContext()` (cached per request) is every portal page's entry point. Layouts do not re-render on client
  navigation, so each page checks its own access (`RequireTeamPerm` for Owner-only pages; denied roles get the
  permission-denied panel under the page title). Portal APIs use `requireLicenseMember(req, { perm, mutation })`
  (session, active account, CSRF + same origin on mutations, verified email, team permission); new code may use the
  equivalent `requireAccountRole(perm, { verified: true })`. Account ids never come from the client; other accounts'
  objects answer 404.
- The middleware forwards `x-axs-path` (pathname + search, always overwritten) when the session cookie is present, so
  the layout can send stale sessions to `/sign-in?next=` and unverified customers to `/verify?next=`.
- The portal shell uses `line-height: normal` like the prototype (the site body is 1.6); popovers, menus and the
  drawer carry it too. Prototype colours without a token map to the nearest token; the "full" utilisation orange
  #C26A1F is read from `chartColors` inline until a palette class exists.
- Global search is an inline ARIA combobox under the top-bar field (Ctrl/Cmd+K, arrows, Enter, Escape), fed by
  `GET /api/account/search?q=` (min 2 characters; licenses, devices, orders, tickets; up to 8 per type, 20 in all; a
  pasted full key is matched by its keyed hash within the account). The bell is a menu (latest 6, "Mark all as read",
  "View all notifications"); the help icon is a menu (Help center, Installation guides, "Raise a ticket").
- Unknown `/account/*` URLs render the in-shell not-found page (HTTP 200, because the shell streams under
  `loading.tsx`; noindex). New full-page states: "No business account" (verified customer without an active
  membership) and "We can’t load your account right now" (database unavailable).
- Buttons a role lacks stay visible with `aria-disabled` and a "Requires {roles}" tooltip (`DisabledAction`,
  `PermissionAction`, `PageAction perm`); the APIs enforce the same TEAM_PERMS. Downloads need `downloads`; renew,
  buy and upgrade need `purchases`; Reveal needs `keys.reveal`; deactivate, rename, locations need `devices.manage`.
- Links into `/orders/:id` are full page loads (Razorpay CSP, Phase 3): order rows, payment rows, the license
  "Issued · Order" fact, search results and notifications.

Lists and tables (`components/data-table/*`, `lib/url-state.ts`, `lib/csv.ts`)
- URL state: `?q=&<filter>=&sort=(-)<id>&page=` (admin: `filter[x]=`); defaults are left out; a search, filter or sort
  change returns to page 1; a page past the end shows the last page. `aria-sort` only on the sorted column.
- Tables become cards below 760px (default cards built from the columns; the prototype scrolled sideways). Selection
  is not offered on phones and is pruned to the visible rows, so bulk actions act on what is shown.
- CSV files: BOM, CRLF, every cell quoted, formula guard (`=`, `+`, `-`, `@`, tab, CR, full-width forms), IST
  `YYYY-MM-DD` dates or ISO times, status labels instead of codes. Server exports refuse `Sec-Fetch-Site: cross-site`.
  Orders CSV: the prototype's 9 columns + invoice date, place of supply, billed GSTIN, seller GSTIN (10,000-row cap);
  activity CSV 20,000 rows (`X-Row-Count`, `X-Truncated`); payments CSV is built in the browser from the newest 100.

Overview, software and licenses
- Overview alerts add two kinds to the prototype's three: `expired` (ended in the last 30 days and not replaced by
  another usable license of the product) and `updates_ended` (a one-time license whose updates ended before a newer
  stable release). One alert per kind, with "N more ..." for the rest; order: expiring, expired, updates ended, ticket
  waiting, device limit. Recent activity is Owner-only (the API returns null for others). Spend uses order snapshots.
  Slot bars become one proportional bar above 40 slots; alert CTAs move under the text below 480px.
- Trials start in the portal at `/account/software?trial=<slug>` (the register flow's `next`): a confirm dialog opens
  once on arrival for roles with `trials.start`; states ready / running / used / owned (a working paid license exists:
  link to it) / unavailable / not found; `?trial` is removed after a start or dismissal. `POST /api/account/trials`
  never returns the key and logs "Started free trial". Android installers get download buttons.
- Cart lines for existing licenses (renewal, maintenance, add-on, upgrade) carry `kind` + `targetLicenseId` and
  replace clashing lines (one line per license and kind; an UPGRADE stands alone; a RENEWAL keeps ADDON lines;
  maxQty = max(qty, 10)). Trial -> paid and "Switch to a one-time license" add an UPGRADE line of the same license
  (plan chooser "Choose plan"), never a NEW line. Software's renew CTA opens the license's Renew & upgrade tab.
- License detail: the tab lives in `?tab=` (history.replaceState, no refetch). The revealed key lives only in component
  state, hides at min(server hideAt, 60 s) and is announced in a live region; revoked licenses have no Reveal and no
  renewal options. Unknown, malformed and foreign ids render "License not found" inline (HTTP 200). Devices show
  "{os} · v{appVersion}" (the account API never returns fingerprints) and "Not seen recently" after 30 days; the
  license Devices tab adds rename and a location select. Lists page client-side at 50 rows.
- Bulk device deactivation plans per license with the deactivations left this year, skips the rest with a note and
  stops a license after 429 `reset_limit`. Locations: "Manage locations" on Devices (add, rename, delete; deleting moves
  devices to Unassigned; selects offer "Unassigned").

Orders, billing and notifications
- "Invoice" downloads the PDF with fetch + Blob (refusals become a toast, never a saved JSON file); orders without an
  invoice show "View". Status filter groups: Pending = AWAITING_PAYMENT, CONFIRMING, PENDING, REVIEW; Refunded =
  REFUNDED + PARTIALLY_REFUNDED (new badge "Partly refunded"). The Orders description mentions guest checkouts only on
  the account where the member's guest orders are claimed (the account they created themselves).
- Billing: State / UT is a select of the GST states; a GSTIN needs a state and must match it; a save that changes
  nothing writes no activity row; members without `billing.edit` see a read-only form. Payment methods copy promises no
  automatic charges (rule 2).
- Notifications: `PATCH /api/account/notifications` (same as `PATCH /api/me/preferences`) saves the email preferences
  immediately; turning offers on records the consent time and turning them off records `offersWithdrawnAt` (DPDP).
  The list pages 30 at a time ("Show more"); `?filter=unread`; items without a link are buttons that mark them read.

Tickets and uploads (`lib/portal/tickets.ts`, `lib/portal/uploads.ts`)
- "Open" = OPEN + AWAITING_CUSTOMER; default tab All; 20 per page; a Product filter appears with 2+ products. A
  RESOLVED ticket reads as Closed 14 days after `resolvedAt` (derived on read, enforced on reopen; a cron that stores
  CLOSED is pending). Viewers read tickets but cannot reply or reopen. A full license key pasted into a subject or
  message is stored masked. The product must be published or licensed by the account; a foreign `licenseId` is 422.
  `/account/tickets/new?license=LIC-x|product=<id>` preselects the form (license "Get help" links use it).
- Attachments: up to 5 per message, PNG/JPEG/PDF/TXT by extension and signed content type, 10 MB; presigned PUT, then
  confirm (a `head()` size check; nothing is stored because Upload has no confirmed state) and attach (checked again,
  conditional update). Downloads: `GET /api/account/uploads/:id/download` -> `{ url, expiresAt, fileName }` or 303 with
  `?redirect=1`. Development presigned PUTs go to the dev-only `PUT /api/dev/storage/<key>` (HMAC-checked).
- Production: ticket pages allow the bucket origin in CSP `connect-src` (`lib/storage/upload-origin.ts`, computed by
  `next build`, so the STORAGE_* variables must be set at build time); the bucket needs CORS for PUT with
  Content-Type from APP_URL.

Team, invitations, activity and security (`lib/portal/team.ts`, `lib/portal/invites.ts`, `app/(auth)/invite`)
- Invite member is a dialog (role descriptions from TEAM_ROLE_META); pending invitees can be Billing admin, Technical
  contact or Viewer (Owner only after they join); role changes and removals ask for confirmation; Resend sends a fresh
  link (older links stop working; not logged); "Invite expired" when no working link exists. Team writes lock the
  BusinessAccount row and re-check that the actor is still an active Owner; at most 100 members plus invitations.
  Removing a member clears it as the active account on their sessions (next request: another membership or "No
  business account"). Revoking an invitation deletes the unused placeholder user, so its link then reads as invalid
  (not "revoked") and the address can register normally.
- Invite tokens are `<AuthToken id>.<256-bit secret>` (SHA-256 of the secret stored), 7 days, single use. The
  team_invite email is queued in the outbox inside the transaction and dispatched right after the commit; its row keeps
  the link until it is purged (a purge job is pending). Accepting logs "Joined the team" ({email} · {Role}).
- `/invite?token=`: the preview is read on the server with the same per-IP limit as `GET /api/invites/:token`;
  existing-account invitees sign in (email prefilled through sessionStorage) and come back; someone signed in as a
  different person is asked to sign out first; a new person sets a name and password, which verifies the email.
- Activity log: Owner-only; entries record the actor (`actorId` + name at the time); kinds license, security,
  billing, team, ticket, download; server CSV export of everything matching the filters.
- Security page: a wrong current password shows inline; turning two-step off asks for the password in a dialog
  ("Incorrect password."); turning it on needs a verified email; "Sign out all others" asks for confirmation and is
  hidden without other sessions; sessions show browser/OS and the truncated IP, 8 at a time ("Show N more sessions").
  Account data downloads the Owner-only JSON export (no keys, hashes, ciphertext, storage keys or staff notes).

Rate limits
- Every portal limit lives in RATE_LIMITS (`lib/auth/rate-limit.ts`) with the keys it had when it was defined next to
  its route: accountDevices 60/10 min, ordersExport 20/10 min, billingUpdate 30/10 min, accountLocations 60/10 min,
  trialStart 10/h, accountSearch 120/min, notificationWrites 120/10 min, accountExport 5/h, twoStepOff 5/15 min,
  twoStepToggle 20/h, profileUpdate 30/10 min, ticketCreate 10/h, ticketUpdate 60/h, uploadCreate 30/h, uploadConfirm
  60/h, attachmentDownload 120/h, teamInviteUser 20/h, teamInviteAccount 50/day, teamInviteResend 3/h per invitation,
  invitePreviewIp 60/10 min, inviteAcceptIp 20/15 min, teamChange 60/10 min, activityExport 10/10 min.

Integration fixes (2026-10-07)
- Team invitations and resends now call `kickEmailDispatch()` after the commit: before, the email waited for the
  one-minute cron in production and never reached /dev/mailbox in development.
- CSP: the ticket pages allow the storage upload origin in `connect-src` (see Tickets above); without it every
  production attachment upload was blocked.
- Activity entries record `actorId` for every person-made action: security events (password change, signing out
  sessions), key reveals, device deactivation, rename and move, member downloads (not guest order links) and "Placed
  order" (the order's placedBy). Device-made and staff entries keep a null actor.
- Palette `warn.bar` (#C26A1F, graphics only) replaces the inline chart colour and `peach-fg` stand-ins on the
  Overview slot bars and renewal dots, the Licenses device bars and the license Devices bar.
- `scripts/check-portal.mjs`: every /account route for Owner, Billing admin and Technical contact at 1280 and 360
  (status, console, overflow, one h1, axe) plus the Owner, Billing and Technical journeys; it removes what it created.
  `scripts/check-storefront.mjs` no longer treats /account as a pending route.
  check-portal retries a page once (and says so) only for two development-runtime failures that cannot happen in a
  production build: the "clientReferenceManifest" invariant and React's dev-only `frame.join is not a function`.
- DB tests are independent of file order again: `tests/db/counters.test.ts` restores the shared Counter table it
  empties, and the license-counter test in `issue-license.test.ts` never moves the counter backwards (in another file
  order both handed out LIC-/T-/AX- ids that already existed, and left the AXS/26-27 invoice series exhausted).

Open items (owner decisions and later phases)
- Owner copy review: the new copy listed by the builders (portal states, trial flow, alerts "N more", device and
  location dialogs, ticket states and upload messages, consent notes, team and invitation pages, security dialogs,
  payment-methods text).
- Schema (next migration): `Upload.confirmedAt` (or an UploadStatus READY) and `StorageDriver.delete(key)`.
- Jobs: close RESOLVED tickets 14 days after resolution (store CLOSED + closedAt); delete PENDING uploads older than
  24 h with their files; purge or redact the html/text of SENT team_invite outbox rows.
- Register flow: an invited address has a password-less placeholder user, so /register answers 409 `email_taken` until
  the invitation is accepted or revoked; consider letting registration take over the placeholder.
- `POST /api/account/trials` still issues a trial when the account holds a working paid license of the product (the
  portal no longer offers it); consider 409.
- `GET /api/me/sessions` is unpaged; `GET /api/account/billing` returns the newest 100 payments (a server
  payments.csv would cover more).
- DataTable: a full-page-load row link mode (Orders uses its own wrapper), `meta.className` precedence on the row
  header cell, and rendering either the cards or the table (both are in the DOM today). PageAction is 39px tall
  (prototype 42px). Phase 6 admin ticket attachments must create Upload rows so customers can download them.
- Production: the storage bucket needs CORS for PUT with Content-Type from APP_URL.

## Phase 5 build decisions (recorded at integration, 2026-10-07)
- Guest-order claim (supersedes the earlier wording in rule 1 and Phase 3): claims go to the earliest account the
  user created and still owns (OWNER membership with `invitedAt` null), never to an account they joined by
  invitation, even after being made Owner there. A user with no own account leaves the orders unclaimed. (Fixes a
  review finding: an Owner could otherwise capture a stranger's guest orders by inviting and promoting them.)
- Registration and checkout "Create an account" take over an invited address's placeholder user; the invitation
  stays pending and its link then needs a sign-in.
- Ticket uploads: the presigned PUT lasts 5 minutes and signs Content-Type and the exact Content-Length; a size
  mismatch at confirm deletes the object (`StorageDriver.delete`). Production S3 needs a bucket CORS rule for PUT
  from the site origin.
- Exports (orders, activity, payments) refuse `Sec-Fetch-Site: cross-site`.
- Accessibility patterns: row selects that act on change (device location, member role) are listboxes where arrow
  keys browse and Enter/click commits (WCAG 3.2.2); below 760px DataTable cards get a "Sort" select; tables whose
  rows update in place keep module-constant columns so focus survives a refresh.
- Billing payment history: a payment without a provider reference shows "-"; the order id names each row.
- Dev data: the seeded pending invitation's link is unusable (random hash re-issued each seed); seeded members
  other than the creating Owner carry `invitedAt`. Rohan (Billing admin) and Kavya (Technical contact) are demo
  logins. check-portal.mjs signs Priya's other sessions out on each run.
- Open for later phases: a job to close RESOLVED tickets after 14 days and purge stale PENDING uploads and sent
  invite email bodies (Phase 7 jobs); admin ticket attachments must create Upload rows (Phase 6); trials are still
  allowed when a paid license for the product exists (owner decision); session list and billing history are
  capped/unpaged (fine at current volumes).
- Owner copy review: all new Phase 5 copy (portal empty states, team/invite messages, ticket and upload errors).

## Phase 6 decisions: admin console (2026-10-07, defaults)
- Routes: /admin (overview) and /admin/<module> for products, plans, releases, orders, customers, coupons, renewals,
  licenses, tickets, content, templates, reports, staff, audit, settings, plus a Leads inbox (contact and demo
  requests; not in the prototype). The open drawer is in the URL (`?id=`), as are filters, sort and page.
- Staff sign in through /sign-in (two-step by emailed code). The prototype's "Signed in as" demo switcher is not
  built; locally, sign in as the seeded staff (Vikram admin, Sneha support, Karan finance) with SEED_DEMO_PASSWORD.
- Permissions: lib/rbac.ts PERMS + ADMIN_MODULES stay the single source; new `leads.view` (owner, admin, support).
  Locked modules show a lock in the sidebar and a permission-denied page; actions a role lacks are disabled with the
  "Requires Owner / Finance" tooltip; every /api/admin route enforces the same permission (a table-driven test covers
  every route x every role).
- Lists: `GET /api/admin/<resource>?q=&filter[x]=&sort=-createdAt&page=1&pageSize=25` -> `{ items, total, page,
  pageSize }`; CSV via `.../export.csv` (reports.export; audit export needs audit.view); every export is audited.
- Destructive actions use DESTRUCTIVE_ACTIONS: a reason (>= 4 chars, <= 500) always, plus the typed id for refund,
  revoke and delete; each successful one writes exactly one AuditLog row in the same transaction; missing reason
  -> 422.
- Refunds (Finance/Owner): full refund in the UI (the API accepts an amount for later partial refunds). The provider
  refund is requested first; then one transaction creates Refund(PENDING) with a credit-note number, revokes the
  licenses the order issued, reverses renewal/add-on/upgrade items from `termsBefore` when the license still matches
  `termsAfter` (otherwise flags the order for review), and writes the audit row. `refund.processed` marks it PROCESSED
  and the order REFUNDED. Refunding a trial that was upgraded to paid revokes the license.
- Catalog edits revalidate the storefront (`revalidateTag(STOREFRONT_TAGS.*)`). Price changes are audited old -> new.
  Plans are archived, never deleted. Product codes are immutable once licenses exist.
- Releases: create a draft, upload installers through presigned PUTs (server verifies size and computes SHA-256 after
  upload), then publish; publishing notifies accounts entitled to the release (in-app notification + "update" email
  through the outbox).
- License actions (Support/Admin/Owner): suspend, reinstate, extend (days), reset devices, revoke (Admin/Owner),
  manual issue (account + plan + reason). Renewals module: licenses expiring within 60 days, with "Send reminder now"
  (renewals.remind) using the renewal templates.
- Tickets (staff): conversation with internal notes (never shown to customers), assign, status and priority; staff
  replies email the customer (ticket_reply) and set firstResponseAt; staff attachments use Upload rows.
- Content: FAQs (home, pricing, support, per product) and the site banner + sample notice (content.manage);
  templates: edit subject/body with variable hints and "Send test" to the signed-in staff member (templates.manage).
- Staff (Owner only): invite by email (AuthToken STAFF_INVITE, 7 days), change role (reason), deactivate/reactivate
  (reason; deactivation signs them out everywhere). Owner and Finance staff always have two-step sign-in on.
  You cannot change your own role or deactivate yourself; at least one active Owner remains.
- Settings (Owner only): business, tax (rate, SAC, invoice prefix 1-3 chars), licensing, sample notice. Secrets are
  never shown or stored here; the page shows only whether each integration is configured (from env).
- Reports: sales by month and product, GST summary by month (taxable, CGST, SGST, IGST; for GSTR-1 preparation),
  license health and support workload, with 7d / 30d / 90d / 12m ranges in IST.

## Phase 6 build decisions (recorded at integration, 2026-10-07)
**Shell and foundation**
- Top-bar search is a module finder (Ctrl/Cmd+K and "/"; locked modules listed as "Restricted"); each module table
  keeps its own search in the DataTable toolbar. No "Signed in as (demo)" switcher; the user chip is a menu (name,
  email, role, View storefront, Sign out).
- The "Test mode" pill shows only for PAYMENT_PROVIDER=mock or a Razorpay key starting `rzp_test` (computed on the
  server). Unknown /admin/* URLs render an in-shell, noindex "Page not found" (HTTP 200: app/admin/loading.tsx streams
  the shell first, as in the portal). Invited or role-less staff see "Your staff access isn't active"; deactivated
  staff no longer have a session. Page titles: "{Module} · Admin — Axiomatic
  Software Solutions". Sidebar greys are admin.text at 70 % / 85 % (no tokens for #8B95A8 / #AEB6C6).
- Every /api/admin route goes through adminRoute(perm): staff session, CSRF + same origin for mutations, refuses
  `Sec-Fetch-Site: cross-site` for every request, strict Zod bodies, error envelope, no-store. List queries are
  lenient (bad filters, sorts and pages fall back to defaults; pageSize capped at 100; never 422).
- Route registry: every route file under app/api/admin has one entry per method in lib/admin/routes/<area>.ts
  (method, path pattern, perm, optional `alsoRequires`, harmless sample body). tests/db/admin-permissions.test.ts
  fails for unregistered handlers, stale entries, a perm that differs from the handler's, and runs every entry as
  signed out, customer and each role (plus a no-CSRF check per mutation and the api-contracts examples, which fail
  rather than skip when a route is missing).
- Destructive helper (lib/admin/destructive.ts runDestructive): reason, typed id, the change and exactly one audit
  row in one transaction; `selfAudited` for services that write their own single row (adminResetDevices);
  `validateDestructive` runs before any provider call. Reason-bearing actions outside DESTRUCTIVE_ACTIONS (release
  withdraw, order review, bulk license and plan actions) use requireReason and also answer 422 `reason_required`.
- Permissions changed at integration: Tickets need `tickets.manage` to open (Finance has no ticket access; locked in
  the sidebar, no badge, API 403). Exports of modules Finance cannot open need the module permission as well as
  reports.export: Leads (leads.view), FAQs (content.manage) and Templates (templates.manage) exports are Owner-only.
  The audit export needs audit.view; the staff export staff.manage (Owner). Every export is audited and rate
  limited (RATE_LIMITS.adminExport, 60 per 10 minutes per staff member).
- Owner and Finance always sign in with an emailed code: the sign-in flow requires two-step for these roles whatever
  `twoStepEnabled` says (the seeded Owner had it off), and the staff list shows them as "On".
- The drawer's scrolling body is a focusable region ("{Kind} details"), so read-only drawers stay keyboard
  scrollable (axe scrollable-region-focusable).

**Overview and reports**
- Ranges 7d / 30d / 90d / 12m in IST, `?range=` in the URL (30d default). The previous period has the same length
  and ends the same time back; 90d uses 13 weekly buckets aligned to today; 12m uses calendar months. KPIs are the
  prototype's five (revenue, paid orders, needs attention, active licenses, open tickets); only revenue shows a change.
- Revenue and paid orders include PARTIALLY_REFUNDED orders net of processed refunds (taxable share); REFUNDED orders
  are excluded. Reports: sales and GST from tax invoices by Invoice.issuedAt (IST months; a refunded invoice stays in
  its month); credit notes (PENDING or PROCESSED refunds with a number) are reported apart in their own month, split
  across taxable/CGST/SGST/IGST in proportion to the order (largest remainder, exact paise); FAILED refunds are
  left out.
- 11 CSV exports (`<report>-<range|all|next90>-<date>.csv`; amounts as decimal rupees, IST ISO dates): sales register,
  GST by state, refunds, license register (masked keys), renewal forecast (next 90 days), support SLA and others in
  lib/admin/reports/model.ts REPORT_EXPORTS.

**Catalog**
- Publishing a product (DRAFT or HIDDEN) is refused (409 `not_ready`, blockers listed) until it has valid page content
  (at least one feature), a main plan on sale and a published stable release with an installer. Categories can be
  deleted only when empty (409 `category_in_use`). Plans are grouped by product by default.
- Releases: draft -> presigned installer uploads (random key segment per upload; HMAC upload token, 12 h, bound to the
  uploader; the server checks the size and computes SHA-256) -> publish (needs one installer). "Latest" is the highest
  PUBLISHED stable version per product (semver). Published releases can be withdrawn with a reason (customers lose
  access); drafts can be deleted. Version and channel are fixed once published; notes stay editable.
- Publishing notifies, after the response, the active customer members of accounts entitled to the release (ACTIVE or
  TRIAL, not expired, updatesUntil >= releasedAt), stable channel only: in-app "update" notification (href
  `/account/software?release=<id>`, also the re-run dedupe marker) and the `release_available` email to verified
  members with update emails on. The storefront product pages now show stable-channel releases only.

**Orders and refunds**
- Refund: validate reason, typed id and role; then one transaction: `SELECT ... FOR UPDATE` on the order, the provider
  refund (a double click waits and gets 409 `already_refunded`; a provider refusal rolls back, 502), Refund(PENDING)
  with the credit-note number, license revocation / term reversal (LicenseEvent `terms_restored`), the customer's
  notification and `refund_issued` email, and the audit row. `refund.processed` marks it PROCESSED and the order
  REFUNDED. Captured REVIEW orders can be refunded (no credit note without a tax invoice) and closed with "Mark
  reviewed" (refunds.issue, reason; 409 `refund_first` / `refund_pending`).
- Order stats: "Paid (all time)" = PAID + PARTIALLY_REFUNDED; "Pending" = PENDING + CONFIRMING; "Refunded" = issued
  refunds. Extra filters: date presets / from-to (IST), coupon, provider. Staff open invoices through
  GET /api/admin/orders/:id/invoice.pdf. Replay needs payments.replay.

**Customers, licenses and renewals**
- Customers are business accounts shown through their first active Owner; lifetime value = PAID orders in full plus
  PARTIALLY_REFUNDED net of processed refunds (GST included); ORDERS counts paid orders only.
- Staff license actions write LicenseEvents with the staff name, never the reason; a staff revoke shows the customer
  "Revoked by Axiomatic Support."; reinstate restores TRIAL for trial plans. Manual issue never returns or shows the
  key: the owner gets `license_issued` with a link to the portal, where the key is revealed with their password.
- Renewals: AUTO-RENEW is replaced by LAST REMINDER (no mandates). "Send reminder now" (renewals.remind) picks
  renewal_30, renewal_7 (last 7 days) or license_expired, emails active Owners and Billing admins with renewal emails
  on (or the order email for unclaimed licenses), once per license, template and IST day. The automatic reminders run
  daily through GET /api/cron/renewals (Bearer CRON_SECRET): renewal_30 at 23-30 days and renewal_7 within 7 days,
  once per license, template and term, no audit rows.

**Tickets, content and templates**
- Staff replies set AWAITING_CUSTOMER (reopening resolved or closed tickets), set firstResponseAt once, auto-assign
  unassigned tickets to the replier, notify only an opener who is still an active member, honour their ticket email
  preference, and add "{First} (Axiomatic Support)" entries to the customer's activity. Internal notes never reach
  the portal and do not bump updatedAt. First response = firstResponseAt, else the first public staff message; the
  stat is the median of tickets opened in the last 30 days. Staff attachments are Upload rows of the ticket's
  account (portal upload limits, keyed per staff user). No CSV on tickets (Reports has "Support SLA").
- Banner and sample notice: /api/admin/content/banner and /content/sample-notice (content.manage); Settings (Owner)
  can also edit the sample notice. FAQs: new ones go last on their page; Move up/down renumbers in steps of 10.
- Templates: a draft template sends the built-in copy; catalogue templates without a row show "Built-in" until first
  saved; unknown placeholders are 422; "Send test" goes only to the signed-in staff member, renders the unsaved copy
  with sample data and "[Test]" in the subject, 10 per hour, audited.
- Coupons start paused; delete needs a reason and the typed code and is refused (409 `coupon_used`) once any order
  used the code. Leads: leads.view may update status and notes (notes are the audit reason); "Scheduled" is offered
  for demo requests only.

**Staff, audit and settings**
- Staff invitations: AuthToken STAFF_INVITE `<id>.<secret>`, 7 days, single use; a resend voids older links; revoking
  deletes the pending user; customer emails are refused (409 `customer_email`); a browser with any session must sign
  out first (403 `signed_in`). The /staff-invite page sets name and password and signs the person in. Invitation
  limits live in lib/admin/staff/limits.ts. Staff list order: role, then active / invited / deactivated, then name;
  "Invite expired" when no link works.
- Audit log: append-only (GET routes only); the action filter is a slug of the action label over the newest 5,000
  rows plus the known vocabulary; IPs show as prefixes.
- Settings sections: business, tax (rate, SAC, invoice and credit note prefixes, next numbers read-only), licensing,
  sample notice. One "Updated settings" audit row per changed field ("old -> new"). Integrations (payments, storage,
  email, Redis) show only kind, configured/not and test/live mode, never values.

**Integration fixes and notes**
- License-key redaction in logs and audit text needs the same separator at every group boundary (all four dashes or
  none), so file names like `license-register-2026-10-07.csv` are no longer masked; keys in any case and mistyped
  keys are still masked.
- robots.txt also disallows /invite and /staff-invite (token links). The dev seed's Owner now has two-step on.
- Prisma 7 with @prisma/adapter-pg runs the relation queries of an `include` concurrently, which inside an
  interactive transaction makes pg 8 queue them with a "client.query() when the client is already executing a query"
  deprecation warning (e.g. the refund transaction's order load). It works with pg 8; check Prisma's adapter before
  any upgrade to pg 9. App code inside transactions runs its own queries one after the other.
- Dev data: NotificationTemplate rows staff_invite, refund_issued and release_available were added to the dev DB
  (seed rows; the seed itself already has them).
- Mock provider (development only): a scheduled mock webhook that gets no answer (network error or the 15 s timeout,
  e.g. while the dev server compiles the webhook route) or a 5xx is sent again with the same event id after 5 s and
  20 s (lib/payments/mock-delivery.ts MOCK_RETRY_DELAYS_MS); the webhook route is idempotent per event and order.
- scripts/check-admin.mjs is the Phase 6 end-to-end check (pages x roles x widths, reasons, and the Administrator,
  Support, Finance and Owner journeys); it removes exactly the records it created, by id.
- Needed before production with STORAGE_DRIVER=s3: next.config.ts UPLOAD_CSP_PATHS must also list `/admin/releases`
  and `/admin/tickets` (installer and staff attachment uploads PUT straight to the bucket; today only the portal ticket
  pages allow its origin in `connect-src`), and the bucket CORS rule must allow PUT from APP_URL.
- Open for Phase 7: licenseHealthCounts and the license / customer stats read whole tables
  (cache them at the 25 lakh scale); index License(productId, accountId) for the release fan-out; trusted-device
  cookies survive deactivation followed by reactivation (needs a per-user security epoch); the renewals cron walks
  every license in the two windows each day (batch the dedupe lookups at scale); renewal_30 copy ("renew to keep
  billing") and the license_issued wording for manual issues ("from order LIC-…") need owner review.
- Owner copy review: all new Phase 6 copy (module-specific COPY constants in lib/admin/**/model.ts, the Leads module,
  report panels, staff invitation page and email, template test, publish blockers, review and refund messages).

## Phase 6 build decisions (recorded 2026-10-07 night)
- Invitation emails (staff and team) are sent directly and never stored in the outbox; the API returns `emailSent`
  and the UI offers "Resend" when sending failed. `pnpm exec tsx scripts/redact-invite-emails.ts` redacts any older
  stored invitation emails (run once on databases that ever stored them).
- Refunds: `refund.failed` sends the order to REVIEW and the refund can be issued again; refunds still PENDING after a
  day are reconciled with the provider every 6 hours; duplicate captured payments are refunded by `paymentId`
  ("Refund duplicate payment"); a refund made in the provider dashboard is recorded for duplicates and flags REVIEW for
  the paying payment. The Razorpay webhook must also send `refund.failed`.
- Staff role changes sign the person out. "Expiring" is fixed at 60 days (shown read-only in Settings).
- Delete draft release, Remove installer, Delete category and Revoke invitation ask for a reason (destructive rules).
- Admin tables: right-aligned (numeric/date) columns sort descending on first click; changing a filter clears the bulk
  selection (search and paging keep it). Tickets stats: Open, Unassigned, High priority, Resolved, First response.
- /staff-invite lives in its own route group with a staff brand panel.
- Owner copy review: Phase 6 module copy, Leads, report panels, staff invitation page/email, refund and review
  messages, destructive-action titles. A failed refund does not email the customer (owner to decide).

## Deployment (aaPanel, no Docker) - recorded 2026-10-07
- See deploy/README.md and docs/deploy-today.md: PM2 runs `next start` on 127.0.0.1:3000 from release folders
  (`current` symlink, shared `.env.production`), PostgreSQL (UTF-8, C) and Redis from the aaPanel App Store, an aaPanel
  site with Let's Encrypt reverse-proxies to the app (TRUSTED_PROXY_HOPS=1), aaPanel Cron runs the job scripts, daily
  pg_dump backups. Production data comes from scripts/bootstrap-production.ts (catalog + first owner, no demo data).
- Order agreed with the owner: finish Phase 6, then Phase 7, then deploy (test mode: Razorpay test keys, sample content).

## Phase 7 decisions: hardening (2026-10-07, defaults)
- CSP: the upload origin (S3 bucket) is allowed in connect-src on /account/* and /admin/* (installer uploads and staff
  attachments too). Authenticated/dynamic areas get a strict nonce-based script policy; static storefront pages stay
  static (no per-request nonce) with our inline scripts covered by hashes where possible. Final choice recorded by the
  security pass.
- HSTS: `max-age=31536000` by default for the test release; `includeSubDomains; preload` only when
  SECURITY_HSTS_STRICT=1 (turn on before live sales once every subdomain serves HTTPS).
- Trusted-device cookies carry User.securityEpoch; it is bumped on password reset/change, staff deactivation or role
  change and turning two-step off, which invalidates every trusted device at once.
- Maintenance job (`/api/cron/maintenance`, daily): close tickets RESOLVED for 14 days, delete PENDING uploads older
  than 24 h (storage + row), redact bodies of SENT outbox emails older than 30 days, purge expired rate-limit buckets,
  sessions and auth tokens older than 30 days past expiry, AccountActivity older than 24 months, WebhookDelivery older
  than 180 days. Renewal reminders stay in `/api/cron/renewals` (30 and 7 days before expiry).
- E2E: Playwright suite in tests/e2e (`pnpm e2e`) against the dev server with the mock provider, covering the test-plan
  journeys; production uses scripts/smoke-prod.mjs.
- Deploy script: a failed health check after the switch rolls back to the previous release automatically.

## Phase 7 build decisions (recorded at integration, 2026-10-08)
Open owner decisions and copy-review items are collected in `docs/owner-decisions.md` (L1-L7, P1-P5, T1-T8, S1-S7,
A1, Copy). Record each answer here with the date, then mark it decided there.

Security (docs/security.md):
- CSP final choice: a STRICT nonce policy (`'nonce-…' 'strict-dynamic'` plus the sha256 of the price and banner head
  scripts, no `'unsafe-inline'` for scripts) set per request by `middleware.ts` on /account/*, /admin/*, /checkout,
  /orders/:id, /sign-in, /register, /forgot, /reset, /verify, /invite and /staff-invite (all dynamically rendered;
  they must stay so). The prerendered/ISR storefront, /cart included, keeps the STATIC policy (`'self'
  'unsafe-inline'`): Next inlines per-page RSC payload scripts there that can be neither nonced nor hashed on cached
  pages. Both policies have `script-src-attr 'none'` and `base-uri 'none'`. The storage bucket origin is in
  connect-src on every page (client navigation keeps the first page's CSP); this supersedes the Phase 6 note about
  UPLOAD_CSP_PATHS. Razorpay sources only on /checkout and /orders/:id. Inline scripts must be constants listed in
  `lib/security/inline-scripts.ts` (the banner text travels in `data-banner-text`). Zod runs jitless in the browser.
- New headers: COOP same-origin (same-origin-allow-popups on the Razorpay pages), a broader Permissions-Policy
  (Razorpay iframes may use payment), X-Permitted-Cross-Domain-Policies none. HSTS `max-age=31536000`, plus
  `includeSubDomains; preload` when SECURITY_HSTS_STRICT is true; read by `next build`, so turning it on needs a
  deploy, not a restart. `deploy/.env.production.example` carries `SECURITY_HSTS_STRICT=false`.
- Trusted-device cookies are version 2 and carry User.securityEpoch, bumped in the same transaction on password reset
  and change, staff deactivation, reactivation and role change, and turning two-step off
  (tests/db/security-epoch.test.ts). Version 1 cookies are refused (one extra code per trusted device).
- `lib/log.ts` also masks Bearer tokens, Authorization values and secret-looking name=value pairs in free text.
- Storefront links into /account and /admin stay client navigations (S4 in owner-decisions.md).

Maintenance job (lib/jobs, `GET|POST /api/cron/maintenance`, `deploy/cron-maintenance.sh`, daily 22:00 UTC after the
21:00 backup):
- Tickets RESOLVED with resolvedAt <= now-14 d become CLOSED with closedAt = resolvedAt + 14 d (updatedAt unchanged; no
  email, activity or audit). PENDING uploads older than 24 h: files deleted while the rows are locked, then the rows; a
  missing file counts as deleted; an upload whose file cannot be deleted keeps its row and the run answers 500.
- SENT outbox emails with sentAt older than 30 d: html, text and subject emptied, recipient masked like the logs; id,
  templateId, dedupeKey, status, attempts, lastError and timestamps kept; PENDING and FAILED rows untouched (S6).
- Purges: RateLimitBucket with resetAt <= now; Session and AuthToken expired, revoked or used more than 30 d ago;
  AccountActivity older than 24 calendar months (IST); WebhookDelivery older than 180 d; WebhookEvent kept.
- 500 rows per statement and 25 uploads per transaction, FOR UPDATE SKIP LOCKED, at most 100,000 rows per task, a
  240 s budget shared fairly between tasks; unfinished tasks are listed in `more`. AuthToken rows are counted as
  `verificationsPurged`.
- Integration fix: every batch picks its rows in a MATERIALIZED CTE (`WITH picked AS MATERIALIZED (SELECT … LIMIT n
  FOR UPDATE SKIP LOCKED) UPDATE|DELETE … FROM|USING picked`), never `WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP
  LOCKED)`. Under a nested-loop semi join Postgres re-runs such a subquery per outer row, its locks skip the rows the
  statement already changed, and the statement changed every matching row (a full DB run purged 7 sessions with a cap
  of 5). The outbox claim (`claimDueEmails`) had the same shape and now uses the CTE too. Rule for new code: never put
  `LIMIT … FOR UPDATE SKIP LOCKED` in an IN-subquery (tests/db/jobs-batch-limit.test.ts forces the plan).
- Renewal reminders stay in `/api/cron/renewals` (tests/db/jobs-renewals.test.ts).

Deploy:
- `deploy.sh` rolls back automatically when the new release fails after the switch (PM2 cannot start it, /api/health
  is not 200 within AXS_HEALTH_TIMEOUT, or a process runs in the wrong folder): `current` goes back to the previous
  release, which is reloaded. Exit status 3 when the previous release is healthy again; 1 when there is no previous
  release, it is incomplete or it is unhealthy too. Migrations are forward-only and are not undone.
- PM2 caps the V8 heap per process: `node_args: --max-old-space-size=$AXS_HEAP_MB` (default 512; 768 with
  AXS_MAX_MEMORY=1500M on 8 GB+ servers). Production PostgreSQL settings: shared_buffers 1GB (2GB with 8 GB+ RAM),
  effective_cache_size 2GB, work_mem 16MB, maintenance_work_mem 256MB, random_page_cost 1.1 (deploy/README.md).
- `scripts/smoke-prod.mjs` also checks COOP, X-Permitted-Cross-Domain-Policies, the strict nonce policy on /sign-in
  and /checkout (a fresh nonce per response, carried by the page's scripts), COOP same-origin-allow-popups on
  /checkout and that /api/cron/maintenance refuses requests without the secret.

E2E: Playwright suite in tests/e2e (`pnpm e2e`; projects desktop 1280x900 and mobile 360x780) against a dev server
with the mock provider, console email and the seed. It removes only what it recorded (throwaway
`e2e-<tag>-*@example.test` users, their orders and audit rows) and restores shared records through the admin API.
Known Next/React development-runtime failures become test annotations, not failures. `E2E_BASE_URL` points it at
another dev server.

Performance (docs/performance.md, budgets there):
- Storefront downloaded JS <= 230 kB gzip (<= 260 kB with forms), portal/admin <= 300 kB (Next column), Lighthouse
  mobile Performance >= 90 and 100 for the other categories.
- Server-renderable components import Radix deep entries (`radix-ui/slot`), never the `radix-ui` barrel; the
  storefront client graph contains no Zod (cart and compare stores validate by hand; the header menu's name helpers
  live in `account-menu-model.ts`). Zod jitless is set through `globalThis.__zod_globalConfig` in
  `instrumentation-client.ts`, without importing Zod. Guarded by tests/unit/perf-bundle-guards.test.ts.
- `htmlLimitedBots: /.*/` in next.config.ts: metadata is rendered in `<head>` for every user agent.
- Admin license search is a UNION of license ids per searched table; customers sorted by an order aggregate pick the
  page ids from the aggregate first, then load 25 full rows.
- The partial active-device index is not needed; revisit if deactivated devices outnumber live ones. pg_trgm will be
  enabled for the admin contains-searches by the index migration (open, below). Admin overview, reports, license
  stats and unfiltered totals get a 60 s cache before about 10 lakh licenses; customer aggregates are denormalised
  past a few lakh accounts.

Accessibility (docs/accessibility.md): target WCAG 2.1 AA plus 2.4.11 (focus not obscured) and reduced motion.
- Forced colours are supported: states use ARIA attributes (aria-selected, aria-pressed, aria-current,
  data-highlighted) that app/globals.css maps to the system Highlight; focus is hidden with `outline-hidden`, never
  `outline-none`; solid buttons get a ButtonText border and the switch is outlined; charts and bars use
  `forced-color-adjust: none`.
- Wide tables scroll inside ScrollRegion (`components/ui/scroll-region.tsx`), never the page; combobox popups scroll on
  the listbox itself; dimmed (stale) content keeps at least 85 % opacity (4.5:1); rings inside dark toasts use
  primary-accent; scripted smooth scrolls check prefers-reduced-motion. ConfirmDialog stops its submit event from
  reaching an enclosing form.
- The 60 s key auto-hide is kept as a security measure, an accepted deviation from WCAG 2.2.1 for the owner to
  confirm (A1). Guards: tests/unit/a11y-pass.test.ts and scripts/check-a11y.mjs.

Docs: README (index of every doc), docs/architecture.md (current module map: "Modules in `lib/`"), docs/api.md (all
route files), docs/owner-decisions.md, docs/security.md, docs/performance.md, docs/accessibility.md.

Open after Phase 7 (not needed for the test release):
- Index migration (schema owner): the trigram, report-window and license-health indexes of docs/performance.md
  "Proposed changes" item 3, and the maintenance indexes (AccountActivity.createdAt, AuthToken.expiresAt,
  Upload(status, createdAt), OutboxEmail.redactedAt with (status, redactedAt, sentAt)); once `redactedAt` exists the
  outbox redaction selects on it instead of `html <> ''`. Before about 10 lakh licenses.
- Renewal reminders open one transaction per license in the windows; batch the dedupe lookups at scale.
- E2E in CI, the 1,000 req/s device API test on production-like servers, the order-link token in the URL (S2).
- Owner copy review of the Phase 7 copy (owner-decisions.md "Copy review").

## Phase 7 review fixes (recorded 2026-10-08, final security and deploy review)
- Signed-out redirect: `middleware.ts` builds `/sign-in?next=<path>` on APP_URL's origin (the request's own origin only
  when APP_URL is missing or not a URL). Behind aaPanel Nginx, `next start -H 127.0.0.1` hands middleware
  `http(s)://localhost:<port>/...`, and Next.js only makes a middleware Location relative when its origin equals the -H
  origin, so the old `req.nextUrl.clone()` sent every cookie-less visit to /account or /admin (email links, the
  activation API's manageUrl, storefront client navigations) to `https://localhost:3000/sign-in`. A relative Location
  is impossible (Next.js parses middleware redirects as absolute). Never build an absolute URL for the browser from
  `req.nextUrl` or the Host header; use APP_URL (tests/unit/auth-helpers.test.ts). `deploy/aapanel-nginx.conf` also
  rewrites any Location naming localhost/127.0.0.1 to a path (`proxy_redirect` regex) as a safety net.
- Privileges: aaPanel Cron runs tasks as root, and everything under /www/wwwroot/axiomatic belongs to the app user, so
  each task's content is `runuser -u axiomatic -- bash /www/wwwroot/axiomatic/current/deploy/<script>` (four jobs and
  the backup). `cron-job.sh` and `backup.sh` refuse root (`refuse_root_job` in deploy/common.sh, skipped only when root
  owns AXS_BASE), cron locks live in shared/run, `/www/backup/axiomatic` is created once by root
  (`install -d -m 700 -o axiomatic -g axiomatic`). `db-setup.sh` is the only root script, run from `src/` during setup
  before the app has run; later runs use `--host 127.0.0.1 --superuser postgres` as the app user (deploy/README.md
  "Privileges").
- Invalid production environment: `instrumentation.ts` prints the EnvError message (variable names only) and calls
  `process.exit(1)`. Throwing only made `next start` log "Failed to prepare server" and answer 500 while PM2 showed the
  process online; now PM2 restarts it and stops at max_restarts ("errored"), as the docs say.
- Order-link token: the order page's status polls send it in the `X-Order-Token` header (lib/orders/token-header.ts);
  `orderTokenFrom()` reads body `t`, then the header, then `?t=` (still used by page links and the invoice PDF link,
  S2). Nginx's error log records request lines with query strings during restarts; the go-live check now greps it too.
- Cron logging: a 200 run is idle (silent) when no number in the whole body is above 0 and no task is listed in
  `more`; the old regex never matched reconcile's nested summary, which logged a line every 10 minutes.
- Razorpay webhook events everywhere (env template included): payment.captured, order.paid, payment.failed,
  refund.processed, refund.failed.
