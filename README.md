# axiomaticsoftwaresolutions.com

Storefront, purchase journey, customer portal, admin console and license activation API for selling licensed
business software in India (Next.js 15 App Router, TypeScript, Tailwind 4, Prisma 7 + PostgreSQL 17, Redis).

## Documentation
| Document | For |
|---|---|
| [`docs/decisions.md`](docs/decisions.md) | Binding decisions, business rules and deviations from the handoff, phase by phase |
| [`docs/architecture.md`](docs/architecture.md) | How the app is built: modules, purchase -> webhook -> fulfilment -> activation, security controls, jobs, deployment |
| [`docs/api.md`](docs/api.md) | Every implemented endpoint with its auth, permissions and main error codes |
| [`docs/activation-api.md`](docs/activation-api.md) | Guide for app developers: activate, validate, deactivate, offline tokens |
| [`docs/owner-decisions.md`](docs/owner-decisions.md) | Open owner decisions and the copy waiting for review |
| [`docs/security.md`](docs/security.md) | Threat model, headers and CSP, cookies, secrets, incidents, dependency audit |
| [`docs/scaling.md`](docs/scaling.md), [`docs/performance.md`](docs/performance.md) | Scale target (25 lakh licenses), Redis, pooling, indexes, benchmarks, budgets |
| [`docs/accessibility.md`](docs/accessibility.md) | WCAG 2.1 AA target, method, findings and fixes, contrast table, known limitations, rules for new UI |
| [`docs/deploy-today.md`](docs/deploy-today.md), [`deploy/README.md`](deploy/README.md), [`docs/go-live-checklist.md`](docs/go-live-checklist.md) | Production (see below) |
| `../design_handoff_axiomatic/` (read-only) | Design reference: prototypes, API contracts, test plan |

## Requirements
- Node.js 20.19 or newer (production uses Node.js 24), pnpm 11
- PostgreSQL 17 on `localhost:5432` (or the embedded development database below)
- Optional: a Redis-compatible server for rate limits (required in production)

## First-time setup
1. `pnpm install` (uses a hoisted `node_modules`, because the repo drive is exFAT and has no symlinks).
2. Create the database role and databases as a Postgres superuser. `CREATEDB` lets `prisma migrate dev` create its
   shadow database. The dev password `axiomatic` matches `.env.example`; use your own and update `.env.local` if you prefer:
   ```sql
   CREATE ROLE axiomatic LOGIN CREATEDB PASSWORD 'axiomatic';
   CREATE DATABASE axiomatic OWNER axiomatic;
   CREATE DATABASE axiomatic_test OWNER axiomatic;
   ```
3. `pnpm secrets` writes `.env.local` with fresh development secrets and an Ed25519 key pair.
   `DATABASE_URL` and `TEST_DATABASE_URL` default to the role above; change them if you chose another password.
   (`pnpm secrets --rotate-signing` replaces only the activation-token key pair.)
4. `pnpm db:deploy`, then `pnpm db:seed` (sample data; the seed refuses to run in production).
   Seed logins use `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD` and `SEED_DEMO_PASSWORD` from `.env.local` (portal demo
   members of Sharma Medicals: priya@ (Owner), rohan@ (Billing admin) and kavya@sharmamedicals.example (Technical contact);
   staff: Vikram (Administrator), Sneha (Support), Karan (Finance)). Two-step sign-in (an emailed code) is optional for
   every account, staff included: the seed turns it on for its staff, whose codes appear at `/dev/mailbox`. Customers
   switch it in Security, staff in Admin > My profile (`/admin/profile`, from the account menu in the top bar).
5. Optional: `pnpm storage:seed` writes placeholder installers so downloads work with `STORAGE_DRIVER=local`.
6. `pnpm dev`, then open http://localhost:3000 (storefront), `/account` (portal) and `/admin` (console).

Local development runs with `PAYMENT_PROVIDER=mock` (the mock payment page `/dev/mock-checkout` sends real signed
webhooks), `EMAIL_TRANSPORT=console` (emails, codes and links at `/dev/mailbox`) and `STORAGE_DRIVER=local` (files in
`.storage/`); outside production these are also the defaults when the variables are unset. `lib/env.ts` refuses all
three in production.

Razorpay, SMTP and the storage bucket can also be saved by the Owner in Admin > Settings > Integrations
(docs/admin-integrations-design.md). A configuration saved there wins over the env file for that integration, so a
saved payment, email or storage setting replaces the development driver: remove it ("Remove saved settings") to get the
mock, the dev mailbox or the local disk back. The e2e suite refuses to start while anything is saved there.

### No Postgres login? Use the dev database
`pnpm db:dev` starts a private PostgreSQL 17 (embedded, dev only) on 127.0.0.1:5433 with the role and databases above
(data in `.pgdata/`, UTF-8). Point `DATABASE_URL` / `TEST_DATABASE_URL` at port 5433, then run `pnpm db:deploy` and
`pnpm db:seed`. Keep that terminal open while you work.

The database must use UTF-8 (the content contains the rupee sign and arrows). On Windows, create databases with
`CREATE DATABASE axiomatic OWNER axiomatic ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;`.

### Redis (optional locally)
Without `REDIS_URL` the rate limits use Postgres buckets. To run against Redis, start a local Redis-compatible server
(e.g. Memurai on Windows, 127.0.0.1:6379) and set `REDIS_URL=redis://127.0.0.1:6379`. With `TRUSTED_PROXY_HOPS=0`
(the development default) every local request shares the "unknown" IP buckets; `check-purchase.mjs` and the E2E
suite clear them on local servers before they run.

## Everyday commands
| Command | What it does |
|---|---|
| `pnpm dev` | Dev server on http://localhost:3000. Development-only tools: UI gallery `/dev/ui`, emails sent by the console transport (codes, reset links) at `/dev/mailbox`, the mock payment page `/dev/mock-checkout` |
| `pnpm typecheck` / `pnpm lint` | `tsc --noEmit` / `eslint .` |
| `pnpm test:unit` | Pure unit tests (no database) |
| `pnpm test:db` | DB tests in an isolated schema of `TEST_DATABASE_URL`, dropped afterwards |
| `pnpm check:all` | Type check, lint, unit and DB tests in one run (stops at the first failure); run it before every deploy |
| `pnpm e2e` / `pnpm e2e:ui` | Playwright end-to-end suite (`tests/e2e`, the test-plan journeys) in the installed Google Chrome against the running dev server with `PAYMENT_PROVIDER=mock`, `EMAIL_TRANSPORT=console` and the seed; HTML report in `playwright-report/`; `--project=desktop` or `--project=mobile` runs one project; `e2e:ui` opens Playwright's UI mode. Switches: `E2E_BASE_URL`, `E2E_KEEP_DATA=1`, `E2E_KEEP_LIMITS=1`, `E2E_HMR=1` (`tests/e2e/support/env.ts`) |
| `node scripts/check-storefront.mjs` | Crawls every storefront, cart, checkout and auth page at 1280 and 360px: status, console errors, landmarks, overflow, axe (`--base=URL`, default the dev server) |
| `node scripts/check-purchase.mjs` | End-to-end purchase and auth journeys against a dev server with `PAYMENT_PROVIDER=mock` and `EMAIL_TRANSPORT=console` (guest purchase, claim on verification, GST, coupons, pending/failed/canceled payments, lockout, two-step); `--only=a,c` runs a subset |
| `node scripts/check-portal.mjs` | Customer portal check against a dev server with `EMAIL_TRANSPORT=console` and the seed: every `/account` page as Owner, Billing admin and Technical contact at 1280 and 360px (status, console, overflow, one h1, axe), then the Owner, Billing and Technical journeys (key reveal, devices, renewal to cart, billing, tickets with attachments, team invitation accepted from `/dev/mailbox`, activity CSV, preferences, sessions). Removes what it created; `--only=pages,owner,billing,technical`, `--keep-data` |
| `node scripts/check-admin.mjs` | Admin console check against a dev server with `PAYMENT_PROVIDER=mock`, `EMAIL_TRANSPORT=console`, `STORAGE_DRIVER=local` and the seed: every `/admin` module (plus drawers) as Owner, Administrator, Support and Finance at 1280 and 360px (status, locks per `lib/rbac.ts`, console, overflow, one h1, axe), every destructive API without a reason (422) and the reason dialogs (Revoke invitation, Remove installer, Delete draft, Delete category), then the Administrator (plan price + storefront, release upload and publish, category delete, coupon), Support (ticket reply and internal note, suspend / reinstate, a new customer with the one-time set-password link, mark email verified, edit the mobile), Finance (refund with credit note; cannot revoke; a payment-link order in "New order", an offline payment and a billing correction with its credit note) and Owner (staff invitation, role change, settings, audit CSV) journeys, plus My profile for every role. Staff with two-step on (the seeded ones) sign in with the code from `/dev/mailbox`. Removes what it created; `--only=pages,reasons,admin,support,finance,owner`, `--keep-data` |
| `pnpm build` / `pnpm start` | Production build and server (the build needs a reachable database and a production-valid environment) |
| `pnpm icons` | Regenerate the icon registry after editing `components/icons/icon-names.ts` |
| `pnpm db:migrate` | Create and apply a migration after a `prisma/schema.prisma` change (`prisma migrate dev`) |
| `pnpm db:reset` | Drop, re-migrate and re-seed the development database |
| `pnpm storage:seed` | Development downloads: writes small SAMPLE placeholder installers under `.storage/` for every seeded release file, served by `/api/dev/storage` (`node scripts/storage-seed.mjs`) |
| `node scripts/bench-validate.mjs` | Throughput of `POST /api/v1/licenses/validate` against your own server (`--concurrency`, `--duration`, `--warmup`, `--licenses`, `--activate-concurrency`, `--spoof-ip`, `--stale`, `--json`; several `--base` URLs round robin); see `docs/performance.md` |
| `node scripts/perf-bundle.mjs` | JavaScript per page: `--dist=.next` reads a build's manifests (first-load JS with `--budget`), `--base=<url>` measures what a browser really downloads from a running production server |
| `node scripts/perf-lighthouse.mjs --base=<url> --runs=3` | Lighthouse (mobile, or `--preset=desktop`) against a production server, median row per page (`npx --yes lighthouse@12`) |
| `node scripts/perf-db.mjs create\|explain\|indexes\|drop --schema=perf_<name>` | Database at scale: a scratch schema with production-sized synthetic data and `EXPLAIN ANALYZE` of the app's own queries (`docs/performance.md`) |
| `node scripts/check-a11y.mjs` | Accessibility check of states the crawls never reach: Tab walks (skip link, visible and unobscured focus), menus, dialogs and drawers (focus in, trap, Escape, focus return), form error states, the two-step step, the order page in every state, comboboxes and row selects, reflow at 320/640px and WCAG text spacing, reduced motion, forced colours; `--only=focus,store,auth,orders,portal,admin,reflow,motion,forced`, `--base=URL`; see `docs/accessibility.md` |
| `node scripts/shot.mjs <url> <out.png>` | Screenshot a page with the installed Chrome (`--width`, `--full`, `--slices=N`) |
| `pnpm env:prod --out <file>` | **Server only, once:** writes the production env file (e.g. `/www/wwwroot/axiomatic/shared/.env.production`, mode 600) from `deploy/.env.production.example` with fresh secrets; prints names only; refuses to replace a file without `--force` (`node scripts/gen-prod-env.mjs`) |
| `pnpm bootstrap:prod` | **Server only:** catalog, settings, counters and the first Owner (`BOOTSTRAP_OWNER_*`; password sign-in, two-step off until turned on in Admin > My profile once email works) for an empty production database, no demo data; `--dry-run` first, `--update-catalog` after catalog copy changes (`tsx scripts/bootstrap-production.ts`; `deploy.sh --first-run` runs it for you) |
| `pnpm exec tsx scripts/redact-invite-emails.ts` | **One-off:** removes invitation links that older versions stored in the email outbox (`--dry-run` first); for databases that ran a build before invitation emails were sent directly |
| `node scripts/smoke-prod.mjs --base=<url>` | Read-only checks of a deployed site: TLS, redirects, security headers (including COOP and the strict nonce CSP on the auth and checkout pages), health, pages, closed dev and cron routes (maintenance included), webhook signature, device API; `--allow-http` for a local production server |

## Project map
```
app/
  (store)/            storefront: /, /software, /software/[slug], /pricing, /compare, /cart, /contact, /about,
                      /support, /docs/[slug], /legal/[doc], /orders/[id] (order page)
  (checkout)/         /checkout
  (auth)/             /sign-in, /register, /verify, /forgot, /reset, /invite
  (staff-auth)/       /staff-invite
  account/            customer portal (/account/...)
  admin/              admin console (/admin/...), one folder per module
  api/                route handlers (docs/api.md)
  dev/                development-only pages: /dev/ui, /dev/mailbox, /dev/mock-checkout
components/           ui (shadcn/Radix primitives), store, checkout, auth, account, admin, data-table, icons, seo
lib/                  server and shared logic (docs/architecture.md "Modules in lib/"); lib/rbac.ts = permissions
content/              code-managed copy: home, pricing, about, support, docs guides, legal documents
prisma/               schema.prisma, migrations, seed.ts and seed-data/ (bootstrap.ts = production catalog + Owner)
scripts/              setup, check, benchmark and production helper scripts (table above)
deploy/               aaPanel server scripts: deploy.sh, rollback.sh, restart.sh, backup.sh, cron-*.sh, Nginx block
tests/                unit/ (pure), db/ (isolated schema), e2e/ (Playwright), support/ (shared helpers)
docs/                 decisions, architecture, API, activation guide, owner decisions, security, scaling, deploy
middleware.ts         strict CSP nonce, optimistic /account and /admin redirects, /api/dev 404 in production
instrumentation.ts    server start-up: env validation in production, Redis rate-limit store
```

## Production
The first release runs on an aaPanel VPS without Docker (PM2 + `next start`, PostgreSQL and Redis from the aaPanel App
Store, aaPanel Nginx with Let's Encrypt in front), in test mode (Razorpay test keys, sample content).
- [`docs/deploy-today.md`](docs/deploy-today.md): the step-by-step first deployment, from an empty server to a test
  purchase, plus updates, rollback, logs and backups.
- [`deploy/README.md`](deploy/README.md): operator reference for the server scripts (`deploy.sh` with automatic
  rollback, `rollback.sh`, `restart.sh`, `backup.sh`, the cron tasks), settings, secret rotation and scaling.
- [`docs/go-live-checklist.md`](docs/go-live-checklist.md): what to verify after the test deploy and what must change
  before live sales (live Razorpay keys and webhook, real business details, `SECURITY_HSTS_STRICT=1`, clean data).

## Notes
- Money is integer paise; times are stored in UTC and shown in IST (`lib/money.ts`, `lib/dates.ts`).
- Never log or persist full license keys, passwords or tokens; use `lib/log.ts`, which redacts them.
- Permissions live only in `lib/rbac.ts`. A new `/api/admin` route must be registered in `lib/admin/routes/<area>.ts`
  (the permission test fails otherwise); a new inline script must be listed in `lib/security/inline-scripts.ts` (the
  strict CSP blocks it otherwise).
- Scheduled jobs (production): `GET /api/cron/emails` every minute, `GET /api/cron/reconcile` every 10 minutes,
  `GET /api/cron/renewals` once a day (renewal reminders) and `GET /api/cron/maintenance` once a day (clean-up and
  retention), all with `Authorization: Bearer $CRON_SECRET` (on the server: the `deploy/cron-*.sh` scripts). Payment
  webhooks go to `/api/webhooks/payments/razorpay` (Admin > Settings > Integrations shows the exact URL); Razorpay must
  send `payment.captured`, `payment.failed`, `order.paid`, `refund.processed` and `refund.failed`.
- Production access logs must not keep query strings: order links carry the order token (`/orders/<id>?t=...`).
- `next build` fixes the static security headers (`SECURITY_HSTS_STRICT` is read at build time, so changing it needs a
  deploy). It no longer fixes the storage bucket: the middleware (Node.js runtime, every page) adds the bucket origin of
  the current storage settings to the CSP `connect-src` at runtime (ticket attachments and installer uploads go
  straight to the bucket), so a bucket saved in Admin applies without a rebuild; the Settings page reloads itself after a storage change, other
  pages opened before it need a reload. The bucket needs CORS for `PUT` with `Content-Type` from `APP_URL`.
- Payment, email and storage credentials: saved in Admin > Settings > Integrations (Owner only, password re-entry,
  secrets encrypted with a key derived from `LICENSE_KEY_ENC_KEY`, audited); the `PAYMENT_*`, `EMAIL_*`, `SMTP_*` and
  `STORAGE_*` variables are only a fallback and production starts without them (each integration then shows "Not
  configured" and its features answer clear errors).
- `next.config.ts` contains a guarded workaround for building on Windows exFAT volumes. It does nothing on NTFS,
  Linux or macOS.
- Scale target (25 lakh licenses): see "Scale target" in `docs/decisions.md`, `docs/scaling.md` and
  `docs/performance.md`.
- Rate limits: `REDIS_URL` is required in production (the server refuses to start without it); locally it is optional
  (see "Redis" above).
- Database pool: `DATABASE_POOL_MAX` (10), `DATABASE_POOL_TIMEOUT_MS` (5000) and `DATABASE_STATEMENT_TIMEOUT_MS`
  (5000) bound each process's pool; a saturated database answers 503 `unavailable` (see `docs/scaling.md`).
- Git on exFAT: git refuses the repository ("dubious ownership") because exFAT records no file owner. Either run
  `git config --global --add safe.directory "E:/Developer/Axiomatc Web Solutions Pvt. Ltd/Axiomatic Software Solutions"`
  yourself, or move the project to an NTFS drive (which also removes the exFAT build workaround).
