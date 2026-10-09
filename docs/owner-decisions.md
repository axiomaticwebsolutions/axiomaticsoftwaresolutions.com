# Owner decisions and copy review

Every decision still open for the owner, and every piece of builder-written copy that waits for review. Collected on
2026-10-07 (Phase 7) from [`decisions.md`](decisions.md) (all phases), [`go-live-checklist.md`](go-live-checklist.md),
[`security.md`](security.md), [`phase1-review-followups.md`](phase1-review-followups.md) and the Phase 7 hardening
summaries.

Each item gives the **context**, the **default** (what the code does today, and what the test-mode release runs
with) and **if decided otherwise** (what would change, and where). None of them blocks the test-mode release
(Razorpay test keys, sample content). Record each answer in `docs/decisions.md` with the date, so the builders can act
on it; items marked "Before live sales" are also on the go-live checklist.

## At a glance

| # | Decision | Needed by | Default today |
|---|---|---|---|
| [L1](#l1-fingerprint-hash-in-activation-tokens) | Fingerprint hash in activation tokens | Before any app ships | Raw fingerprint (`fp`) in the token |
| [L2](#l2-free-trial-when-the-account-already-has-a-paid-license) | Free trial when the account already has a paid license | Later | The API allows it (the portal does not offer it) |
| [L3](#l3-per-unit-renewals-and-device-add-on-slots) | Per-unit renewals and device add-on slots | Before a per-unit product sells add-ons | A renewal sets the device limit to its quantity |
| [L4](#l4-viewers-starting-trials) | Viewers starting trials | Later | Owner, Billing admin and Technical contact only |
| [L5](#l5-support-override-for-the-activation-churn-cap) | Support override for the activation churn cap | Later | No override |
| [L6](#l6-licensing-numbers) | Licensing numbers (deactivations, grace, links) | Before live sales | 3 deactivations a year, 7-day grace, 10-minute links |
| [L7](#l7-beta-release-channel) | Beta release channel | Later | Customers see stable releases only |
| [P1](#p1-email-the-customer-when-a-refund-fails) | Email the customer when a refund fails | Before live sales | No customer email; the order goes to In review |
| [P2](#p2-refund-of-a-trial-converted-to-paid) | Refund of a trial converted to paid | Before live sales | The license is revoked |
| [P3](#p3-partial-refunds-in-the-console) | Partial refunds in the console | Later | Full refunds only (the API accepts an amount) |
| [P4](#p4-renewal-reminders-for-monthly-subscriptions) | Renewal reminders for monthly subscriptions | Before live sales, if monthly plans are sold | The 30-day reminder arrives in the first week |
| [P5](#p5-test-mode-orders-before-live-sales) | Test-mode orders before live sales | Before live sales | Fresh database recommended |
| [T1](#t1-gst-computation-and-settings) | GST computation and settings (with the CA) | Before live sales | Tax on the order's taxable value, to the paisa; 18 %, SAC 997331 |
| [T2](#t2-e-invoicing-irn-and-qr) | E-invoicing (IRN and QR) | Before live sales | Not built |
| [T3](#t3-gstin-checksum-validation) | GSTIN checksum validation | Before live sales | Format and state code only |
| [T4](#t4-invoice-and-credit-note-series) | Invoice and credit-note series | Before live sales | `AXS/<FY>/<n>` and `AXC/<FY>/<n>` |
| [T5](#t5-legal-pages) | Legal pages | Before live sales | Sample text with `[bracketed]` values |
| [T6](#t6-privacy-notice-and-retention-dpdp) | Privacy notice and retention periods (DPDP) | Before live sales | Periods set by the maintenance job |
| [T7](#t7-cert-in-reporting-and-log-retention) | CERT-In reporting and log retention | Before live sales | No proxy access log; app logs rotated by size |
| [T8](#t8-sample-catalog-seller-details-and-screenshots) | Sample catalog, seller details and screenshots | Before live sales | Sample, labelled as such |
| [S1](#s1-hsts-for-every-subdomain-and-preload) | HSTS for every subdomain, preload | Before live sales | One year, this host only |
| [S2](#s2-order-link-token-in-the-url) | Order-link token in the URL | Later | `?t=` in links, proxy access log off |
| [S3](#s3-__host--cookie-names) | `__Host-` cookie names | Later | Plain names |
| [S4](#s4-strict-csp-for-portal-visits-that-start-on-the-storefront) | Strict CSP for portal visits that start on the storefront | Later | Static policy until the next full page load |
| [S5](#s5-sign-in-attempts-per-ip) | Sign-in attempts per IP | Later | 20 failures per 15 minutes per IP |
| [S6](#s6-redact-failed-outbox-emails) | Redact failed outbox emails | Later | Only sent emails are redacted |
| [S7](#s7-hosting-for-the-25-lakh-license-target) | Hosting for the 25 lakh license target | Before large customers ship apps | One aaPanel VPS |
| [A1](#a1-license-keys-hide-after-60-seconds) | License keys hide after 60 seconds (WCAG 2.2.1) | Before live sales | Hidden after 60 s, no "keep showing" control |
| [Copy](#copy-review) | Copy review | Before live sales | Builder copy, listed by area |

## Licensing and activation

### L1. Fingerprint hash in activation tokens
**Context.** Activation tokens are EdDSA-signed JWTs with the claims `{ lic, fp, prod }`
(`lib/licensing/activation-token.ts`); `fp` is the device fingerprint the app sends (SHA-256 hex of hardware
identifiers). Anyone holding a token can read its payload. A leaked token (pasted into a support ticket, left in a
backup) therefore lets its holder call `/validate` and `/deactivate` for that device, because the fingerprint those
calls require is in the token. It cannot unlock another computer offline: the app compares `fp` with its own
fingerprint. Recorded as an open owner decision in Phase 4; `docs/activation-api.md` tells app developers to keep
the token as secret as the key.

**Default.** The raw fingerprint, exactly as the handoff contract (`api-contracts.md` section 6) defines it.

**If decided otherwise** (the Phase 4 recommendation): sign `fph = base64url(SHA-256("axs-fp-v1|" + fp))` instead of
`fp`. A leaked token is then useless against the API without the real fingerprint. Changes: the token claims, the
fingerprint comparison in `/validate` and `/deactivate` (`lib/licensing/activation.ts`), the offline check described
in `docs/activation-api.md`, and their tests. Cheap now; once apps that verify tokens offline have shipped, it needs a
versioned claim and a transition period. **Decide before any app build embeds the production public key.**

### L2. Free trial when the account already has a paid license
**Context.** `POST /api/account/trials` refuses a second trial of a product (409 `trial_used`), but it does not check
for a paid license: an account that bought the product without trying it first can still start a trial
(`startTrial()` in `lib/licensing/issue.ts`). The portal hides the offer in that case (the trial state "owned" links
to the existing license), so only a direct API call gets one.

**Default.** Allowed.

**If decided otherwise.** Refuse with 409 (for example `already_licensed`, "You already have a license for this
product.") in `startTrial()`, plus a test. No data change.

### L3. Per-unit renewals and device add-on slots
**Context.** On plans sold per unit (per terminal), the quantity sets the device limit. Renewing such a license sets
`deviceLimit = quantity` (`lib/licensing/terms.ts`), so slots bought earlier as device add-ons are dropped. Checkout refuses a renewal quantity
below the number of active computers (`below_active_devices`), so no computer is switched off, but the spare add-on
slots are gone (a device still above the limit would be deactivated, least recently seen first). Renewals of other plans keep the license's device limit, add-ons
included. In the sample catalog only Restaurant Billing is per-unit, and it has no add-on plan, so nobody is affected
today.

**Default.** The renewal quantity replaces the device limit.

**If decided otherwise.** Either never sell device add-ons for per-unit products (no code change), or keep the add-on
slots across per-unit renewals (limit = quantity + add-on slots). The second needs the add-on slots recorded
separately (a License column, or the sum of the license's fulfilled ADDON items), a change in `terms.ts`, the renewal
tab and cart copy, and tests.

### L4. Viewers starting trials
**Context.** The team permission `trials.start` covers Owner, Billing admin and Technical contact (`lib/rbac.ts`); the
handoff contract allowed any team role (Phase 1 review, item 12).

**Default.** Viewers cannot start trials (Viewer is the read-only role).

**If decided otherwise.** Add `VIEWER` to `trials.start` (one line plus the permission matrix tests); the portal then
offers the trial to Viewers too.

### L5. Support override for the activation churn cap
**Context.** A license can activate at most max(3, 2 x device limit) new computers in any 30 days (429
`activation_churn`), so one slot cannot be passed around machines that keep running offline on their tokens. The
admin "Reset devices" action frees slots but does not clear this window (Phase 4 fix pass).

**Default.** No override: support waits until the oldest activation leaves the window (the app gets `Retry-After`).

**If decided otherwise.** An admin action such as "Allow one more activation" (`licenses.manage`, reason, audited)
that exempts the next activation: a new route, service and drawer button, plus tests.

### L6. Licensing numbers
**Context.** The numbers customers and app developers will notice. Some are settings, some environment values, some
code constants.

| Number | Default | Where it lives | To change it |
|---|---|---|---|
| Self-service device deactivations per license per IST calendar year | 3 | Admin > Settings > Licensing | Edit the setting (applies at once) |
| Offline grace: activation token lifetime and `nextCheckBefore` | 7 days (never past the license end) | `LICENSE_OFFLINE_GRACE_DAYS` in `shared/.env.production` | Edit and restart; tell app developers (`docs/activation-api.md`) |
| How long past expiry `/validate` still refreshes a token | 30 days | `MAX_ACTIVATION_GRACE_DAYS` in `lib/licensing/activation-token.ts` | Code change |
| "Expiring" window (portal, admin, renewals) | 60 days | `EXPIRING_DAYS` in `lib/licensing/status.ts` (shown read-only in Settings) | Code change |
| Download link lifetime | min(setting, `DOWNLOAD_LINK_TTL_SECONDS`, 600 s) | Admin > Settings and env | Setting; never above 10 minutes |
| Device "Not seen recently" | 30 days | `STALE_DEVICE_DAYS` in `lib/licensing/account.ts` | Code change |
| Trial length, one-time update months | per plan (`trialDays`, `updatesMonths`, default 12) | Admin > Plans & pricing | Plan edit |

**Default.** As in the table.

**If decided otherwise.** Settings and plans change from the console; the code constants are one-line changes with
tests. A shorter offline grace makes apps call `/validate` more often (see `docs/scaling.md` for the load).

### L7. Beta release channel
**Context.** Customers see and download only `stable` releases (`STABLE_CHANNEL` in `lib/licensing/entitlement.ts`):
`/validate`, the portal, the order page and the storefront all filter on it. Staff can create releases on other
channels; customers never see them.

**Default.** Other channels are invisible to customers.

**If decided otherwise.** A labelled beta programme: an opt-in per account (a schema change), entitlement and
`/validate` filters, and a portal list. About a phase of work.

## Orders, payments and refunds

### P1. Email the customer when a refund fails
**Context.** When Razorpay sends `refund.failed` (for example a closed bank account), the refund becomes FAILED, the
order goes to In review, and Finance can issue the refund again (`lib/payments/webhook.ts`). The customer was emailed
`refund_issued` when the refund was issued and hears nothing when it fails. The licenses stay revoked, because the
refund already revoked or reversed them, and a revoked license cannot be reinstated (staff would issue a new one by
hand). Recorded in the Phase 6 night build decisions ("owner to decide").

**Default.** No customer email; staff see the order In review in Admin > Orders & payments.

**If decided otherwise.** A `refund_failed` email template (subject and body for owner review) queued in the same
transaction, and optionally an internal notice to the finance mailbox. Decide at the same time what happens to the
licenses while the money has not been returned.

### P2. Refund of a trial converted to paid
**Context.** Buying a paid plan from a trial upgrades the trial license (same key, devices and data). Phase 1 proposed
that refunding that purchase should restore the trial terms ("to be confirmed"); Phase 6 built revocation.

**Default.** The refund revokes the license (`isTrialConversion` in `lib/admin/orders/refund-rules.ts`). The account
cannot start another trial of that product.

**If decided otherwise.** Restore the stored `termsBefore` (status TRIAL, trial plan and dates), so the license reads
as an expired trial rather than revoked. A change in `lib/admin/orders/refund.ts` and its tests.

### P3. Partial refunds in the console
**Context.** `POST /api/admin/orders/:id/refund` accepts `amountPaise`, but the console only offers full refunds.
A partial refund needs rules for the licenses (keep all, or pick which to revoke) and a credit note for part of the
order (Reports already split credit notes in proportion).

**Default.** Full refunds only in the UI.

**If decided otherwise.** An amount field in the refund dialog, the license rule, and tests for the credit note and
the GST report.

### P4. Renewal reminders for monthly subscriptions
**Context.** The daily `/api/cron/renewals` job sends `renewal_30` while 23-30 days are left and `renewal_7` in the
last 7 days, once per license, template and term, to active Owners and Billing admins with renewal emails on
(`sendScheduledRenewalReminders` in `lib/admin/renewals/remind.ts`). A monthly subscription has about 30 days left the
moment it is bought, so a monthly buyer gets a "renew" email within the first week (Phase 7 jobs note; sample plan
`rst-monthly`).

**Default.** Both reminders for every term length.

**If decided otherwise.** Skip `renewal_30` for monthly terms (or scale the window to the term) in
`sendScheduledRenewalReminders`; the manual "Send reminder now" can keep its rule.

### P5. Test-mode orders before live sales
**Context.** Test-mode orders take real invoice numbers (`AXS/<FY>/0001` onwards, gap-free) and appear in the GST
summary used for GSTR-1. Counters are never lowered.

**Default.** The go-live checklist recommends starting live on a fresh database (backup, drop, `db-setup.sh`,
`deploy.sh --first-run`), decided with the CA.

**If decided otherwise.** Keep the data and treat the test invoices as the CA advises (for example credit notes),
accepting that the live series does not start at 0001.

## Tax, invoicing and legal

### T1. GST computation and settings
**Context** (`decisions.md` business rule 3, `lib/pricing.ts`). GST is computed once on the order's taxable value
(after the coupon discount), in paise: `gst = round(taxable x rate / 100)`. Intra-state (billing state = the
company's state): `CGST = round(gst / 2)`, `SGST = gst - CGST`; inter-state: `IGST = gst`. The discount and the GST are
allocated to the lines by largest remainder, so the lines always add up to the totals. Place of supply is the billing
state. Prices are stored and listed excluding GST; "incl. GST" displays show exact paise (for example Rs 5,898.82).
Rate 18 % and SAC 997331 are settings.

**Default.** As above, "to be confirmed with the company CA".

**To confirm with the CA.** Order-level computation (rather than per line), rounding to the paisa (rather than whole
rupees), the rate, the SAC, place of supply for buyers without a GSTIN, and the invoice layout (amount in words,
CGST/SGST/IGST columns).

**If the CA wants something else.** Rate and SAC change in Admin > Settings > Tax. A different rounding or
computation changes `gstSplit()` and the allocation in `lib/pricing.ts`, their tests and possibly the invoice PDF
(`lib/invoice`). Invoices keep a snapshot, so earlier invoices never change: decide before the first live sale.

### T2. E-invoicing (IRN and QR)
**Context.** Invoices are PDF tax invoices generated on demand; there is no IRN or signed QR ("No e-invoicing in v1",
`decisions.md`). B2B e-invoicing becomes mandatory above an aggregate-turnover threshold notified by CBIC (Rs 5 crore
at the time of writing; confirm the current rule with the CA).

**Default.** Not built.

**If decided otherwise.** Report each invoice to a GSTIN holder (and each credit note) to the Invoice Registration
Portal through a GSP, store the IRN, acknowledgement and signed QR, print them on the PDF, and handle portal outages
(order paid, invoice waiting for its IRN) and cancellations. A phase-sized change that also needs IRP credentials.

### T3. GSTIN checksum validation
**Context.** `lib/validation/gstin.ts` checks the format and that the first two digits match the billing state. It
deliberately skips the check digit, because the sample GSTINs are not checksum-valid.

**Default.** Format and state code only (checkout, portal billing, Admin > Settings).

**If decided otherwise.** Add the check-digit test once the sample data is gone (see P5) and replace the sample
GSTINs in the seed. A small change; a mistyped GSTIN would then be refused at checkout.

### T4. Invoice and credit-note series
**Context.** Invoices are `AXS/<FY>/<number>` (for example `AXS/26-27/1181`), credit notes `AXC/<FY>/<number>`, FY
April-March in IST from the payment date, gap-free per FY. GST rules cap the number at 16 characters, so a 3-character
prefix allows 999,999 documents per FY. The prefixes are editable (up to 3 characters); the next number is read-only.

**Default.** `AXS` and `AXC`.

**If decided otherwise.** Change the prefixes in Admin > Settings > Tax before the first live sale; issued invoices
keep their numbers.

### T5. Legal pages
**Context.** `/legal/terms`, `/legal/privacy`, `/legal/refund` and `/legal/eula` are code content
(`content/legal/documents.ts`), labelled "Sample - to be reviewed by counsel", with the values counsel must set in
`[brackets]`. Checkout records which version the buyer accepted (`CHECKOUT_TERMS_VERSION`).

**Default.** Sample text.

**If decided otherwise.** Counsel's text goes into `content/legal` with new versions, then a deploy. The refund policy
must match the answers to P1-P3.

### T6. Privacy notice and retention (DPDP)
**Context.** The daily maintenance job (`/api/cron/maintenance`, `lib/jobs/retention.ts`) now enforces these
periods: account activity 24 calendar months; sent emails emptied (body and subject) and the recipient masked after 30
days; sessions and auth tokens deleted 30 days after they expire, are revoked or are used; payment webhook delivery
records 180 days (the processed-event records are kept); unfinished uploads after 24 hours; rate-limit counters when
they lapse. Orders, invoices, licenses, tickets and the audit log are kept. The marketing opt-in is unticked by
default and records consent and withdrawal times; the portal Owner can download the account's data. There is no
account deletion feature in the portal or the console.

**Default.** These periods; the privacy notice is sample text.

**To decide with counsel.** The periods, how erasure requests are handled (by hand today), the grievance contact, and
the processors the notice names (Razorpay, the storage provider, the email provider, the server host). A period is a
constant in `lib/jobs/retention.ts`.

### T7. CERT-In reporting and log retention
**Context.** The CERT-In directions (2022) ask for certain incidents to be reported within 6 hours and for system
logs to be kept for 180 days in India. Today the Nginx access log is off (order links carry a 30-day token in `?t=`),
the app logs are rotated by size (pm2-logrotate, 20 MB x 14 files) and the server logs keep aaPanel's defaults.
`docs/security.md` "Incident basics" flags this for counsel.

**Default.** No 180-day log retention.

**If decided otherwise.** Turn the Nginx access log on with a format that leaves out query strings, kept 180 days; or
first do S2, after which a normal access log is safe; and keep the app logs for 180 days (longer rotation, or shipping
them to retained storage).

### T8. Sample catalog, seller details and screenshots
**Context.** `scripts/bootstrap-production.ts` writes the SAMPLE catalog (products, plans and prices, FAQs, email
templates). Product screenshots are HTML placeholder panels (`content/screenshots.ts`). Seller details are
placeholders until Admin > Settings > Business is filled in. While `business.sample` is on, invoices say they are not
valid tax invoices, legal pages and structured data name the brand instead of the legal entity, and sample notes and
coupon codes show; the sample notice strip is a separate switch.

**Default.** Sample everywhere, labelled.

**If decided otherwise.** Real products, prices, content, code-signed installers and screenshots, then the real
seller details, then `sample` off (go-live checklist, "Catalog and downloads" and "Business, tax and legal").

## Security and operations

### S1. HSTS for every subdomain and preload
**Context.** The app sends `Strict-Transport-Security: max-age=31536000` in production. With
`SECURITY_HSTS_STRICT=1` it adds `includeSubDomains; preload` (`lib/security/headers.ts`). The value is read by
`next build`, so changing it needs a deploy, not just a restart.

**Default.** One year, this host only.

**If decided otherwise.** Before live sales, once every name under the domain (www, mail, panels) serves valid HTTPS:
set it, redeploy, check with curl (go-live checklist). Submitting to the browser preload list is a separate decision:
leaving it takes months.

### S2. Order-link token in the URL
**Context.** Guests reach their order through `/orders/<id>?t=<token>`, a 30-day credential that is also in the order
emails. App logs redact it, but any proxy or CDN access log would store it; that is why the Nginx access log is off.

**Default.** Token in the query string.

**If decided otherwise.** On the first visit, exchange the token for a short-lived httpOnly cookie and redirect to the
clean URL; the proxy can then keep a normal access log (helps T7). A small route and cookie change plus tests.

### S3. `__Host-` cookie names
**Context.** The session, CSRF and trusted-device cookies (`axs_session`, `axs_csrf`, `axs_td`) are Secure, SameSite=Lax
and (except CSRF) httpOnly. A `__Host-` prefix would also stop a sibling subdomain from planting cookies for the site.

**Default.** Plain names.

**If decided otherwise.** Rename the cookies (`lib/auth/cookies.ts`, the middleware's cookie check, the CSRF names).
Everyone is signed out once and every trusted device asks for a code again, so it is cheapest before live sales.

### S4. Strict CSP for portal visits that start on the storefront
**Context.** The portal, admin, checkout, order and auth pages get a strict nonce-based Content-Security-Policy, but an
in-app link keeps the policy of the page the visitor entered on. A visit that starts on a storefront page and moves
into `/account` through in-app links runs under the static storefront policy (`docs/security.md`).

**Default.** Links from the storefront into the portal are in-app links (faster).

**If decided otherwise.** Make those links full page loads (`components/store/account-menu.tsx`,
`components/store/order/order-next-steps.tsx`, `order-not-found.tsx`, `license-card.tsx`,
`components/auth/signed-in-banner.tsx`). Every portal visit then runs under the strict policy, at the cost of one full
page load when entering the portal.

### S5. Sign-in attempts per IP
**Context.** Sign-in allows 5 failed attempts per email and 20 per IP address per 15 minutes (`RATE_LIMITS` in
`lib/auth/rate-limit.ts`). The handoff contract said 5 per IP; the Phase 1 review asked to either lower it or record
the reason.

**Default.** 20 per IP, so an office or mobile network that shares one public address does not lock everyone out.

**If decided otherwise.** Set `signInIp` to 5 (one line and the rate-limit rule test), accepting more lockouts for
shared addresses.

### S6. Redact failed outbox emails
**Context.** The maintenance job empties sent business emails after 30 days (body and subject; the recipient is
masked). Emails that finally failed (after 5 attempts) keep their body and recipient; the Phase 7 jobs work left
them for the owner to decide.

**Default.** Only sent emails are redacted.

**If decided otherwise.** Extend the redaction to failed emails older than 30 days (a small change in
`lib/jobs/tasks.ts`).

### S7. Hosting for the 25 lakh license target
**Context.** Business rule 13 recommended AWS Mumbai (managed Postgres and Redis, S3 and CloudFront, containers); the
owner chose one aaPanel VPS without Docker for the first release. `docs/scaling.md` and `docs/performance.md` hold
the capacity plan (managed Postgres and Redis, more app processes, a CDN for downloads, Postgres settings, a heap cap
per process, proposed indexes). The 1,000 requests/second device API test on production-like servers is still open.

**Default.** One VPS (`AXS_INSTANCES` can add PM2 processes on it).

**If decided otherwise.** Choose the target hosting before large customers ship apps, then run the load test there
(`docs/scaling.md` "Phase 7: what to measure").

## Accessibility

### A1. License keys hide after 60 seconds
**Context.** A revealed license key (the order page after payment, Reveal on the portal license page) is masked again
after 60 seconds (Phase 3 and Phase 5 decisions), so a key left on screen is not read by the next person at the desk.
WCAG 2.2.1 (Timing adjustable) asks that a user can turn off, adjust or extend such a limit; today they can only
reveal the key again (portal, with the password) or copy it while it shows. The Phase 7 accessibility pass recorded
it as an accepted deviation for the owner to confirm (`docs/accessibility.md`, known limitations).

**Default.** Hidden after 60 seconds, announced in a live region; no "keep showing" control.

**If decided otherwise.** Add a "Keep showing for 60 s more" button next to Hide (order page key card and the
portal reveal dialog; `components/store/order/` and `components/account/licenses/`), which meets 2.2.1 while keeping
the security default. The pages hide the key at the server's `hideAt` (60 s after the reveal), so the extension also
needs that rule changed in `docs/decisions.md` and the reveal API.

## Copy review

Copy the builders wrote where the prototype had none, or changed on purpose, listed by area with the file that holds
it. Edit the files (or, for emails, Admin > Templates) and deploy; tests that pin a string fail and need the same edit.
The go-live checklist item "Owner copy review done" points here.

| Area | Where it lives | What to review |
|---|---|---|
| Sign-in, registration, verification, reset, trials | `components/auth/copy.ts`, `lib/auth/flows/common.ts`, `lib/licensing/issue.ts` (trial messages) | Expired, unknown or superseded codes; invalid, used and expired reset links; "That session has already ended."; the two-step step, resend countdown and "Show password"; the header account menu; "1 attempt left."; "Too many attempts. Try again in N hours."; "Enter your name without links or email addresses."; the trial messages "Verify your email to start a free trial." and "This product doesn’t offer a free trial." |
| Checkout and order page | `components/checkout/checkout-form.ts`, `components/store/order/order-model.ts`, `order-not-found.tsx`, `lib/orders/access.ts` | "We couldn’t open the payment page. Your order is saved, so you can pay for it from the order page."; "Still confirming your payment" with "Refresh status"; "Order refunded" / "Order partly refunded"; "This order link has expired"; the create-account help text |
| Emails | `lib/email/defaults.ts` (code defaults) and Admin > Templates | Every body. The `renewal_30` subject "... - renew to keep billing" (renewals are manual, business rule 2); the `license_issued` wording for staff-issued licenses ("from order LIC-..."); `refund_issued`, `release_available`, `staff_invite`, `team_invite`, `lead_received`, `lead_new` |
| Device limits and activation | `lib/checkout/lines.ts`, `lib/licensing/activation.ts`, `lib/licensing/devices.ts` | The two `below_active_devices` messages ("This license has N active computers..."), "Too many computers were activated on this license recently. Contact support to activate another.", the yearly deactivation limit (`reset_limit`) |
| Customer portal | `components/account/**` (copy in the `*-model.ts` files), `lib/portal/*` | Portal states and empty states, the trial flow, alerts "N more ...", device and location dialogs, ticket states and upload messages, consent notes, team and invitation pages, security dialogs, the payment-methods text (no automatic charges) |
| Admin console | `lib/admin/**/model.ts` (module `COPY` constants), `lib/rbac.ts` | Module copy, the Leads module, report panels, the staff invitation page and email, template test, product publish blockers, review and refund messages, destructive-action titles and confirm labels |
| Storefront | `components/store/product/copy.ts`, `content/*.ts`, `content/docs` | Product page policy card, pricing "Ways to pay" and "Refunds" cards, the contact form notice, guides, "Sample" labels |

New in Phase 7:

| Copy | Where it lives |
|---|---|
| Duplicate payments in the order drawer: button "Refund duplicate payment"; dialog "Refund the duplicate payment of <amount> for <order>?" with "Returns this payment through the payment provider. The order, its invoice and its licenses don’t change, and no credit note is generated."; confirm "Refund payment"; toast "Duplicate payment refunded"; row detail "Duplicate payment · <amount> refundable" (or "Duplicate payment") | `DUPLICATE_REFUND_COPY` in `components/admin/orders/order-drawer.tsx`; the toast in `refundToast()`, `lib/admin/orders/model.ts` |
| Invitation email not sent (staff and team): "Invitation created, but the email couldn’t be sent. Use Resend." | `STAFF_INVITE_EMAIL_FAILED` in `components/admin/staff/invite-staff.tsx`; `TEAM_COPY.invitationEmailFailed` in `components/account/team/team-model.ts` |
| Settings read-only fact "Expiring window (days)" with "Licenses ending within this many days read as Expiring." | `SETTINGS_COPY.readOnlyFacts` in `lib/admin/settings/model.ts` |
| Activity is kept 24 months: worth saying on the portal Activity page or in the privacy notice (see T6) | `components/account/activity`, `content/legal` |
| An expired staff invitation reads "No working link" in the staff drawer once its last link is purged (30 days after it expired); the list still says "Invite expired" | `lib/admin/staff/model.ts` |

New on 2026-10-08 (two-step sign-in optional for every account):

| Copy | Where it lives |
|---|---|
| Under the two-step switch (portal Security and Admin > My profile): "Codes are sent by email, so turn this on only once this site’s emails reach you; otherwise you can’t sign in." | `SECURITY_COPY.twoStepEmailNote` in `components/account/security/security-model.ts` |
| Admin > My profile: menu item and title "My profile"; "Your details, two-step verification, password and the devices signed in as you."; card "Your details" with "Only an Owner can change your role, in Staff & roles." | `PROFILE_COPY` in `lib/admin/profile/model.ts` |
| Production bootstrap report: "two-step sign-in off (password only)" and the next step "Once email sending works, turn two-step on in Admin > My profile (go-live checklist)." | `formatBootstrapReport()` in `prisma/seed-data/bootstrap.ts` |

New on 2026-10-09 (coming-soon products and the launch waitlist, decisions.md 2026-10-09):

| Copy | Where it lives |
|---|---|
| The 20 coming-soon products: names, taglines, summaries, planned features, benefits and requirements (written from the market research; no prices or dates). Once in the database, edit them in Admin > Products & categories; the code copy is only used where the catalog addition has not run yet | `prisma/seed-data/coming-soon.ts` |
| The three new categories: "Jewellery", "Wholesale & Distribution", "Manufacturing & Logistics" and their blurbs | `CATEGORIES` in `prisma/seed-data/catalog.ts`; Admin > Products & categories > Categories |
| Product page: badge "Coming soon"; "This software is not on sale yet. Leave your email and we’ll tell you when it launches."; "See software available now"; headings "Planned features", "What it will do for your business", "Planned system requirements"; the form "Notify me when it launches", "We’ll send one email when <product> is ready to buy. No spam.", the notice "We’ll use these details only to tell you when <product> launches. See our privacy policy.", button "Notify me", success "You’re on the list" / "Thanks — we’ll email you when <product> launches." | `COMING_SOON_COPY` in `components/store/product/copy.ts` |
| Catalog filter "Availability: All / Available now / Coming soon" | `lib/storefront/catalog-filter.ts` |
| Software menu and mobile panel (design C, decisions.md "Software menu shows every product"): section labels "Available now" and "Coming soon", the link "See all coming soon →", coming-soon links read aloud as "<short name>, coming soon", mobile category buttons as "<category>, N products"; the bottom bar "Browse all software →", "Compare products", "Licensing explained", "Book a demo" | `SOFTWARE_MENU_SECTIONS`, `SEE_ALL_COMING_SOON_LABEL`, `COMING_SOON_LINK_SUFFIX`, `comingSoonCategoryName`, `BROWSE_ALL_SOFTWARE_LABEL`, `SOFTWARE_MENU_LINKS` in `components/store/active-nav.ts` |
| Internal waitlist email (stored `lead_new` template unchanged): kind "launch waitlist sign-up", Topic "Launch waitlist", Message "Asked to be emailed when <product> launches. No reply is needed now: the website promised only a launch email." | `lib/leads.ts` |
| Admin: "Mark coming soon" and its dialog, the blockers (e.g. "Customers already have licenses for this product. Hide it instead: ..." and "Orders exist for this product. Hide it instead: ..."), the drawer's "Launch waitlist" section; the Leads module description ("... and “Notify me” launch waitlist sign-ups. Contact and demo senders get an automatic acknowledgement email; waitlist sign-ups do not.") and the template label "Contact, demo or waitlist form sent (to sales)" | `lib/admin/catalog/rules.ts`, `components/admin/catalog/product-drawer.tsx`, `components/admin/destructive-action.tsx`, `lib/rbac.ts`, `lib/admin/templates/model.ts` |

Open follow-up: emailing a product's waitlist when it is published is not built (export Leads, filter Type = Waitlist,
and write to them).

## Decided already (change only on purpose)

These were open once and are now settled; they are listed so nobody reopens them by accident.

- Registration takes over an invited address's placeholder user; the invitation stays pending (Phase 5).
- Guest orders are claimed by the earliest account the user created and still owns, never by an account they joined
  by invitation (Phase 5).
- Subscriptions renew manually through the cart; no mandates or automatic charges (business rule 2).
- Two-step sign-in (emailed codes) is optional for every account, staff included: only each person's own setting
  decides, staff switch it in Admin > My profile, and Owner and Finance turn it on once SMTP works (owner decision
  2026-10-08; replaces the Phase 6 rule that Owner and Finance always sign in with an emailed code).
- "Expiring" is fixed at 60 days and shown read-only in Settings (Phase 6 night).
- A failed refund puts the order in review and the refund can be issued again (Phase 6 night; the customer email is
  P1).
- Invitation emails are sent directly and never stored (Phase 6 night).
