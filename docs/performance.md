# Performance: results, method and budgets

Phase 7 measurements (2026-10-07) of the production build: JavaScript per page, Lighthouse, the database at 25 lakh
scale and the device API under load. Scaling design and production settings live in [`scaling.md`](scaling.md); this
file records what was measured, how to measure it again and the budgets new work must keep. Changes that touch app
code are proposals until applied (see "Proposed changes" at the end); measured "after" numbers come from a scratch
copy of the app with those changes, never from edits to the shared tree.

## Summary
- **Device API**: one `next start` process serves about **1,050-1,140 validations/s** on this machine (one CPU core
  saturated, about 0.9 ms CPU per request including the framework), p95 18 ms at 16 concurrent, 80 ms at 64 and
  167 ms at 128 (Little's law: the queue, not the work). Three processes: **2,668 req/s**, p95 122 ms at 128.
  First-of-the-day validations (presence `UPDATE`): 979 req/s, p95 90 ms. Activation bursts: about 500/s per process.
  Postgres time per validation is 0.05 ms (plus 0.03 ms for the daily presence write) at 3 lakh licenses.
- **25 lakh licenses** (morning peak of about 1,000 req/s, bursts to 1,500): plan about six app processes (8 vCPUs, or
  two 4-vCPU servers behind a load balancer) and a separate database server; the single 2 vCPU / 4 GB aaPanel VPS of
  the test launch carries about 300-600 req/s. Details in "Capacity at 25 lakh licenses".
- **JavaScript**: every storefront page shipped all of Radix (the `radix-ui` barrel imported by server components)
  and Zod (cart storage, header menu). Fixing both takes the real first-load JS of `/` from 287 to 208 kB gzip
  (-28 %), `/software` 299 to 221 kB, `/cart` 293 to 215 kB. Next's "First Load JS" column under-reports by about
  55 kB because it leaves out layout chunks: budget on the measured number (`perf-bundle.mjs --base`).
- **Lighthouse** (mobile, simulated, median of 3): Performance 87-91 before, Best Practices 96 everywhere (Zod's eval
  probe violates the CSP) and SEO 91 on `/software` and `/contact` (metadata streamed into `<body>`). With the
  proposed changes: Performance 92-93, Accessibility, Best Practices and SEO 100 on all five pages; LCP 3.2-3.3 s
  simulated (3.5-4.0 before), CLS 0.001-0.004, TBT 10-29 ms.
- **Database** (3 lakh licenses, 5 lakh devices, 2 lakh orders, 10 lakh license events): the device API and portal stay
  in milliseconds. Admin search and aggregate sorts did not: license search 2.3 s, customers by lifetime value 1.4 s,
  overview 0.56 s. Production Postgres settings, 13 indexes (6 of them trigram) and two query rewrites bring them to
  21 ms, 0.19 s and 0.12 s.
- **Memory**: a `next start` process grew to 1.15 GB RSS under load with Node's default heap on a 61 GB machine; with
  `--max-old-space-size=512` it stayed at 0.5 GB with the same throughput. Set it in PM2 (`max_memory_restart` is 1 GB).

## Method and environment
- Machine: AMD Ryzen 9 9900X (12 cores / 24 threads, about 5.5 GHz boost), 61 GB RAM, Windows 11, Node 24.14, shared
  with other work (Lighthouse's benchmark index varied 4,100-5,150), so compare numbers within one table, not across.
- App: Next.js 15.5.27 production build (`next build` with the production-style env: `APP_URL=https://...`,
  `TRUSTED_PROXY_HOPS=1`, `CATALOG_SOURCE=db`, Razorpay test keys, S3 and SMTP placeholders, `REDIS_URL`) in its own
  `NEXT_DIST_DIR`, served by `next start` (no proxy, no CDN, HTTP on localhost).
- Data stores: embedded PostgreSQL 17.10 (stock settings: `shared_buffers` 128 MB, `work_mem` 4 MB,
  `random_page_cost` 4) and Memurai 4.1 (Redis 7.2 protocol) on localhost.
- Tools (all in `scripts/`, no new dependencies; Lighthouse runs through `npx --yes lighthouse@12`):

| Script | Measures |
|---|---|
| `perf-bundle.mjs --dist=<distDir>` | First-load JS per page from the build manifests (Next's numbers), pages over budget, the largest non-shared chunks with the libraries in them |
| `perf-bundle.mjs --base=<url>` | What a browser downloads: HTML and every `<script src>` of each page (raw and gzip), layouts included |
| `perf-lighthouse.mjs --base=<url> --runs=3` | Lighthouse 12 mobile (or `--preset=desktop`), median of the runs, failing scored audits |
| `perf-db.mjs create / explain / indexes / drop` | Scratch schema with production-sized synthetic data; EXPLAIN (ANALYZE, BUFFERS) of every statement the app's read paths send |
| `bench-validate.mjs` | `/validate` throughput and latency (`--warmup`, several `--base` URLs round robin, `--stale` for the morning write path) and the activation burst |

Reproduce (Git Bash; never against the shared dev server, never print `.env.local`):
```bash
# 1. Production build in its own dist dir, then serve it (stop it afterwards; restore tsconfig.json / next-env.d.ts)
NEXT_DIST_DIR=.next-perf APP_URL=https://axiomaticsoftwaresolutions.com TRUSTED_PROXY_HOPS=1 CATALOG_SOURCE=db \
  PAYMENT_PROVIDER=razorpay PAYMENT_KEY_ID=rzp_test_x PAYMENT_KEY_SECRET=... PAYMENT_WEBHOOK_SECRET=... \
  STORAGE_DRIVER=s3 STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... EMAIL_TRANSPORT=smtp SMTP_HOST=smtp.example.com \
  REDIS_URL=redis://127.0.0.1:6379 npx next build      # then the same env with: npx next start -p 3150
node scripts/perf-bundle.mjs --dist=.next-perf
MSYS_NO_PATHCONV=1 node scripts/perf-bundle.mjs --base=http://localhost:3150
MSYS_NO_PATHCONV=1 node scripts/perf-lighthouse.mjs --base=http://localhost:3150 --runs=3
# 2. Database at scale (about 6 minutes and 1.4 GB; drop it when done)
node scripts/perf-db.mjs create --schema=perf_q5
node scripts/perf-db.mjs explain --schema=perf_q5 --settings=work_mem=16MB,random_page_cost=1.1,effective_cache_size=2GB
node scripts/perf-db.mjs indexes --schema=perf_q5        # then explain again; --undo removes them
node scripts/perf-db.mjs drop --schema=perf_q5
# 3. Device API load (licenses >= rate x min(warmup + duration, 60) / 30)
node scripts/bench-validate.mjs --base=http://localhost:3150 --concurrency=64 --duration=30 --warmup=5 \
  --licenses=2500 --activate-concurrency=16 --spoof-ip --json
```

## 1. JavaScript per page
### What the build reported
`next build` flagged (First Load JS, gzip) `/software` 281 kB, `/software/[slug]` 278, `/cart` 269, `/compare` 265, the
portal's `/account/licenses/[id]` 288, `/account/devices` 282, `/account/orders` and `/account/billing` 251, and eight
admin modules at 264-277 kB. The column counts a page's own entry and the root main files but not the chunks of its
layouts. What a browser really downloads (every `<script src>` without `nomodule`, measured on `next start`):

| Page | Next column | Downloaded JS before (raw / gzip) | After the proposed changes |
|---|---|---|---|
| `/` | 232 | 934 / 287 kB | 660 / 208 kB |
| `/software` | 281 | 974 / 299 kB | 704 / 221 kB |
| `/software/medical-billing` | 278 | 955 / 293 kB | 690 / 218 kB |
| `/pricing` | 232 | 934 / 287 kB | 660 / 208 kB |
| `/contact` | 189 | 966 / 297 kB | 785 / 244 kB |
| `/cart` | 269 | 951 / 293 kB | 681 / 215 kB |
| `/compare` | 265 | 951 / 293 kB | 668 / 211 kB |
| `/support` | 233 | 937 / 288 kB | 663 / 209 kB |
| `/sign-in` | 189 | 950 / 293 kB | 778 / 244 kB |
| `/checkout` | 201 | 975 / 301 kB | 812 / 256 kB |

The shared base is 102 kB (React DOM 54 kB, the Next.js runtime 46 kB) plus 9 kB of tailwind-merge.

### Why
1. **The whole of Radix on every page (35 kB plus Popper, Dialog, FocusScope and react-remove-scroll chunks).**
   `components/ui/button.tsx`, `badge.tsx`, `breadcrumb.tsx` and `card.tsx` are server-safe components that do
   `import { Slot } from "radix-ui"`. In the React Server graph that loads the `radix-ui` barrel, which imports all 30
   `@radix-ui/react-*` packages, and those are `"use client"` modules: Next's client-entry plugin turns every one of
   them into a client reference of every route that renders a Button (it cannot tree-shake across the server/client
   boundary). Lighthouse listed the chunk as 82 % unused. Fix: `import * as Slot from "radix-ui/slot"` (the package's
   own deep entry; `Slot.Root` and `Slot.Slottable` unchanged). Measured alone: `/` 232 to 156 kB, `/software` 281 to
   218, `/cart` 269 to 184, `/admin/settings` 277 to 197 (Next column). Client components may keep importing from
   `"radix-ui"`; only modules that can run in the server graph must use the deep entries.
2. **Zod in the storefront (27 kB).** `lib/cart/store.ts` and `lib/compare/store.ts` validate localStorage with Zod,
   and the header account menu (`components/store/account-menu.tsx`, in every storefront layout) imports `firstName` and
   `initials` from `components/auth/auth-model.ts`, which builds the auth form schemas at import. Fix: small
   hand-written validators with the same rules (all 68 existing cart, compare and auth model tests pass on the copy)
   and the two name helpers moved to `account-menu-model.ts` (re-exported by `auth-model.ts`). Zod then loads only
   on pages with forms (auth, contact, checkout, portal, admin).
3. **Zod's eval probe and the CSP.** Zod 4 runs `new Function("")` once, when it builds its first object schema, to
   see whether it may compile parsers. The CSP has no `'unsafe-eval'`, so every page that builds a schema logs a CSP
   violation: the console error behind Lighthouse's "Issues were logged" (Best Practices 96). The security pass added
   `instrumentation-client.ts` with `import { config } from "zod"; config({ jitless: true })`, which fixes the
   violation but puts 3.8 kB of Zod into the shared chunk of every page (measured: 46.8 to 50.6 kB; the same with
   `zod/v4/core`). Setting the flag on Zod's global config object instead (`globalThis.__zod_globalConfig`, which Zod
   reuses when it loads) costs nothing; `tests/unit/perf-zod-config.test.ts` fails if a Zod upgrade stops reading
   that object. Checked in Chrome: no CSP violation on `/`, `/software`, `/pricing`, `/contact`, `/sign-in`,
   `/checkout` or `/cart`.
4. **Icon registry (28 kB, every page with a client-side icon; not changed).** `components/icons/registry.ts` holds
   the path data of every icon (82 KB raw) in one object, so any client component that renders `<Icon>` ships all of
   them (and server-rendered icons repeat their paths in the RSC payload: about 12 KB raw of the 134 KB payload on
   `/`). Options, in order of effort: keep icons in server components where possible; give client components
   per-icon named exports (tree-shakeable) instead of the name lookup; or an SVG sprite file (`<use href>`), cached
   once, which removes icon data from JS and HTML but makes icons wait for one request.
5. **Toasts (sonner, 9.6 kB)** load with every storefront layout; they could be loaded on first use.
6. **Portal and admin** (desktop, signed in): 222-288 kB, from @tanstack/react-table (two chunks, 29 kB), Zod (27 kB),
   the icon registry (28 kB) and the forms. They are under the 300 kB budget below; dialogs with large forms are the
   candidates for `next/dynamic` if a page needs to shrink.

Per-route effect of 1-3 (Next column, gzip kB, scratch build of the same tree): storefront `/` 232 to 156, `/pricing`
232 to 156, `/support` 233 to 157, `/docs/[slug]` 233 to 158, `/legal/[doc]` 231 to 147, `/about` 192 to 107,
`/software` 281 to 192, `/software/[slug]` 278 to 180, `/cart` 269 to 157, `/compare` 265 to 153, `/orders/[id]` 201
to 175; `/account` 213 to 187, `/account/licenses` 248 to 222, `/admin/settings` 277 to 197; pages that build Zod
forms (auth, contact, checkout, most of the portal and admin) unchanged within 1 kB.

## 2. Database at scale
### Data and method
`scripts/perf-db.mjs create` builds a scratch schema (`perf_<name>`) in the development database with the real
migrations, copies the catalog (4 products, 16 plans, releases, settings, templates, FAQs) and generates, in SQL:
50,000 accounts (60,000 customer users and members), 2,00,000 orders with items, payments, 1,65,887 invoices and
6,126 refunds, **3,00,000 licenses, 5,00,000 devices** (10 % deactivated), **10,00,000 license events**, 3,00,000 audit
rows, 5,00,000 account activity rows, 30,000 tickets with 90,000 messages, 4,00,000 webhook deliveries, 1,00,000
downloads, 2,00,000 notifications and outbox emails, 20,000 leads. Account `acc_1` is the large customer (4,005
licenses, about 6,000 devices, 2,000 orders, 20,000 activity rows). 1.4 GB on disk, about 6 minutes to build.
`explain` runs the app's own read paths (the functions the API routes and pages call, through a Prisma client that
records every statement) and re-runs each statement under `EXPLAIN (ANALYZE, BUFFERS)` in a rolled-back transaction,
warm cache. Parallel query is off for these EXPLAINs: on Windows each parallel worker is a new process and costs
about 400 ms to start, which hid the real work (Linux starts them in about a millisecond). Numbers are Postgres
execution time per page or call (all its statements), at 3 lakh licenses.

| Area | Read path | Stock settings | Tuned settings | + indexes | + query rewrites |
|---|---|---|---|---|---|
| device | activate (key-hash lookup, device count, churn check) | 0.3 ms | 0.2 | 0.3 | 0.3 |
| device | validate (license + device) | 0.1 | 0.1 | 0.1 | 0.1 |
| device | validate, first of the day (presence `UPDATE`) | 0.1 | 0.1 | 0.1 | 0.1 |
| portal | licenses, large account (4,005) | 3.3 | 3.4 | 3.5 | 3.4 |
| portal | devices, large account | 257 | 22 | 23 | 21 |
| portal | overview, large account | 105 | 14 | 18 | 17 |
| portal | billing, large account | 30 | 2.8 | 4.1 | 4.4 |
| admin | orders, default (newest first) | 112 | 118 | 14 | 14 |
| admin | orders, search by email | 113 | 135 | 26 | 25 |
| admin | licenses, default (issued, newest first) | 164 | 216 | 75 | 70 |
| admin | licenses, search | **4,347** | **1,269** | 1,108 | **21** |
| admin | licenses, stats row | 93 | 116 | 85 | 93 |
| admin | customers, default (lifetime value) | **1,394** | **1,402** | 1,086 | **186** |
| admin | customers, state filter by last order | 191 | 179 | 140 | 26 |
| admin | audit, default | 29 | 36 | 24 | 25 |
| admin | renewals list + stats | 73 | 104 | 70 | 119 |
| admin | overview 30 days / 12 months | 388 / 522 | 556 / 798 | 122 / 407 | 140 / 359 |
| admin | reports 30 days / 12 months | 245 / 415 | 219 / 420 | 129 / 319 | 132 / 317 |
| jobs | renewals cron batch (200 licenses, 30-day window) | 4.8 | 4.9 | 4.8 | 4.7 |
| jobs | release fan-out batch (500 accounts) | 2.2 | 1.9 | 1.7 | 2.0 |

"Tuned" is `work_mem=16MB, random_page_cost=1.1, effective_cache_size=2GB` (SSD, see below); differences under
about 30 % between columns are machine noise (the machine was shared). The full list (45 read paths, 357 statements)
is what `perf-db.mjs explain` prints.

### Findings
- **Hot path**: activation finds the license by `License_keyHash_key` and its devices by
  `DeviceActivation_licenseId_fingerprint_idx`; validation reads `License_pkey` plus the same device index; the
  presence write is a primary-key `UPDATE`. All well under a millisecond. The partial "active devices" index floated
  in `scaling.md` is not needed (10 % deactivated rows cost nothing measurable).
- **Planner settings** are the biggest single lever for the portal: with the stock `random_page_cost=4` the planner
  read all 5 lakh devices to list one account's 6,000 (257 ms); with SSD settings it uses the license index (22 ms).
  The stock `work_mem=4MB` made hash joins and aggregates spill to disk. Production settings are in "Postgres
  settings" below.
- **Admin license search** OR-ed `ILIKE '%term%'` over License, its account, its order, the account's members and the
  devices, so Postgres joined and tested every license (2.3 s with disk spills). Rewritten as a UNION of license ids
  per table (each branch on its own index, trigram GIN indexes for the contains-match): 13 ms for the page and 11 ms for
  the count. Same results (the 25 existing admin license, customer and renewal DB tests pass on the copy). A very broad
  term that matches nearly every license (e.g. "perf" here) still takes about 0.9 s; that is inherent to sorting
  every match.
- **Customers sorted by lifetime value** (the default view) computed the owner, order aggregates and license count
  for every account to keep 25 (1.4 s at 50,000 accounts, linear in accounts; past the 5 s statement timeout at a few
  lakh accounts). Rewritten in two steps: the page's ids from the sort aggregate alone, then the full rows of those 25
  (186 ms; identical pages for every sort, direction, filter and offset checked). Past a few lakh accounts, keep
  `lifetimeValuePaise`, `paidOrders` and `lastOrderAt` on `BusinessAccount` (maintained by fulfilment and refunds)
  with an index, which makes the sort an index scan.
- **Missing indexes**: the default admin Orders list sorts by `createdAt` with no index (a scan and sort of every
  order); Licenses sorts by `issuedAt` (same); the overview and reports window on `Order.paidAt` and
  `Invoice.issuedAt` (filtered scans of `Order_status_createdAt_idx` reading 1.5 lakh pages); license health counts
  read the heap (an index that also holds `productId` answers them from the index alone: 84 to 3 ms, 49 to 9 ms, 75 to
  37 ms); the "last 4 of the key" search scans License.
- **Whole-table counts and aggregates remain**: the unfiltered totals of the license and order lists, the license
  stats row (5 lakh devices counted, 65-75 ms) and the overview's license health grow with the tables (about 8x at
  25 lakh licenses). Cache them for 60 seconds per process (`unstable_cache` with a tag the admin actions revalidate),
  as `decisions.md` already notes for licenseHealthCounts.
- **Renewal reminders and release fan-out** stay index-bound (5 ms per batch of 200, 2 ms per 500 accounts); the
  outbox dedupe `LIKE 'prefix%'` uses the unique index because the database collation is `C` (keep it so).

### Postgres settings (production)
The stock settings assume spinning disks and 128 MB of shared memory. For the aaPanel VPS (SSD, 4 GB RAM, Postgres
next to the app) set in `postgresql.conf` (aaPanel > App Store > PostgreSQL > Settings, or `ALTER SYSTEM`) and restart:
```
shared_buffers = 1GB              # 25 % of RAM; 2GB on an 8 GB server
effective_cache_size = 2GB        # what the OS can cache for Postgres (about 50 % of RAM)
work_mem = 16MB                   # per sort or hash node: keeps list aggregates in memory
maintenance_work_mem = 256MB      # index builds, vacuum
random_page_cost = 1.1            # SSD: lets the planner use indexes (portal devices 257 to 22 ms)
max_parallel_workers_per_gather = 2   # the default; parallel scans help the admin reports on Linux
```
On managed Postgres (RDS) set the same through a parameter group (RDS defaults `random_page_cost` to 4 too).

## 3. Device API under load
One `next start` process (production build, `REDIS_URL`, `TRUSTED_PROXY_HOPS=1`) on port 3150; `bench-validate.mjs`
on the same machine with a random client address per request (`--spoof-ip`) and enough licenses to stay under the
per-license limit; 5 s warm-up (not counted), 30 s measured, every response checked (`valid: true`):

| Run | Throughput | p50 | p95 | p99 | Max | Errors |
|---|---|---|---|---|---|---|
| validate, 16 concurrent, 1 process | 1,139.5 req/s | 12.4 ms | 17.6 ms | 23.8 ms | 1,339 ms | 4 x 503 of 34,309 |
| validate, 64 concurrent, 1 process | 1,076.7 req/s | 54.2 ms | 79.7 ms | 201.0 ms | 651 ms | 6 x 503 of 32,320 |
| validate, 128 concurrent, 1 process | 1,056.9 req/s | 112.4 ms | 166.9 ms | 316.8 ms | 437 ms | none of 31,750 |
| validate, 128 concurrent, 3 processes (round robin) | 2,667.8 req/s | 27.0 ms | 121.9 ms | 146.7 ms | 451 ms | none of 80,084 |
| validate, first of the day (every request writes `lastSeenAt`), 64 concurrent, 1 process, 8 s | 978.8 req/s | 61.2 ms | 89.5 ms | 111.8 ms | 235 ms | none of 7,879 |
| validate, 64 concurrent, 1 process with `--max-old-space-size=512`, 20 s | 1,080.0 req/s | 52.1 ms | 75.4 ms | 108.4 ms | 1,409 ms | none of 21,737 |
| activate, 16 concurrent, 1 process (2,500 new devices) | 500-616 req/s | 25-29 ms | 34-47 ms | 43-149 ms | | none |
| activate, 32 concurrent, 1 process (9,000 new devices) | 498.8 req/s | 55.1 ms | 80.7 ms | 231.2 ms | | 5 x 503 of 9,000 |
| activate, 64 concurrent, 3 processes (6,000 new devices) | 900.7 req/s | 55.8 ms | 170.9 ms | 500.6 ms | | 3 x 503 of 6,000 |

What this says:
- **One Node process tops out at about 1,050-1,140 validations per second** on this CPU. Its CPU time grew by 44-46 s
  per 45 s run: one core, saturated. That is about 0.9 ms of CPU per validation, almost all of it framework (routing,
  request parsing, the route handler wrapper, JSON); the hot-path work measured in-process is about 0.2 ms of
  signature checks plus about 0.1 ms of Redis and Postgres round trips (`scaling.md`). More concurrency only adds
  queueing (p50 = concurrency / throughput). Three processes gave 2.5x; the database, Redis and the load generator
  shared the same machine, so a dedicated server scales closer to linearly.
- **The first-of-the-day write path costs about 10 %** of throughput (979 against 1,077 req/s at 64): the presence
  `UPDATE` is a primary-key HOT update.
- **Activations** (row lock, count, churn check, device insert, license event, account activity) run at about 500/s per
  process; a burst of 6,000 new devices across three processes finished in 6.7 s.
- **Spurious 503s under saturation.** Every 503 was `rate_limit_store_unavailable`: a Redis call that did not answer
  within the 500 ms command timeout because the Node process itself stalled (the 1.3-1.4 s maximum latencies hit
  every request in flight, not only the Redis calls). The fail-closed policy turns those into `503 unavailable` with
  `Retry-After: 5`, which the apps handle by retrying; at 0.01-0.06 % of requests at full saturation this is
  acceptable. If production shows `rate_limit_store_unavailable` without a Redis incident, raise the command timeout
  to about 1.5 s.
- **Memory.** With Node's default heap (sized from the 61 GB of this machine) the process grew to 1.15 GB RSS;
  capped with `--max-old-space-size=512` it stayed at 0.51 GB with the same throughput and latency. PM2 restarts a
  process above `AXS_MAX_MEMORY` (1 GB), so cap the heap: `NODE_OPTIONS=--max-old-space-size=512` (2-4 GB servers) or
  768 (8 GB).

## 4. Capacity at 25 lakh licenses
Load model (`scaling.md` "Expected load"): about 1.5 devices per license, so 37.5 lakh devices; each validates at
start-up and about once a day, and most shops open between 9 and 11 AM IST. If 70 % of devices start in those two
hours, that is 26 lakh first-of-day validations (each one a presence write) at 365/s on average, and about 900/s in
the busiest quarter hour. Design point: **1,000 validations/s sustained in the morning, bursts to 1,500**, plus the
storefront, portal and cron load, which is small next to it.

Per process: 1,050-1,140 req/s here at 100 % of a 5.5 GHz Zen 5 core. A VPS or cloud vCPU (one hyper-thread of a
2-3.5 GHz server CPU) does roughly half to a third of that for this request mix, so plan **300-350 req/s per process
at 60-70 % CPU** (400-550 at saturation, where 503s and queueing start). Postgres needs about 0.1 ms per validation
plus the presence `UPDATE` (0.1-0.2 vCPU and about 500 small writes/s at the peak); Redis two Lua calls per validation
(negligible); each process holds at most a few of its 10 pooled connections at this rate.

| Stage | Morning validate peak | App | Database and Redis |
|---|---|---|---|
| Test launch (today, < 10,000 licenses) | < 10 req/s | the 2 vCPU / 4 GB aaPanel VPS, `AXS_INSTANCES=1` (2 for gapless reloads), heap capped at 512 MB | same server; settings above |
| Up to about 5 lakh licenses | about 200 req/s | 4 vCPU / 8 GB, `AXS_INSTANCES=2-3` | same server, `shared_buffers=2GB` |
| 25 lakh licenses | about 1,000 req/s, bursts 1,500 | 8 vCPU / 16 GB with `AXS_INSTANCES=6` (about 2,000 req/s at 60 % CPU), or two 4 vCPU servers behind a load balancer for redundancy; device API on its own process group (`scaling.md` "Horizontal scaling") | Postgres on its own 4 vCPU / 16 GB server or managed (6 x 10 pooled connections fit under `max_connections=100`; add PgBouncer beyond that), Redis beside it |

The bursts above capacity are safe to shed: a 429 or 503 makes the app retry later while it keeps working on its
signed token (7-day grace), and the pool and statement timeouts keep a saturated database from queueing work. Measure
the real servers before relying on these numbers (`scaling.md` "Phase 7: what to measure"): one process of the chosen
size, ramped until p95 passes 100 ms, gives the per-vCPU figure to replace the estimate above.

## 5. Lighthouse
Lighthouse 12.8 mobile (Moto G Power emulation, simulated slow 4G and 4x CPU), headless Chrome, median of 3 runs,
against `next start` on localhost (no TLS, no CDN, no HTTP/2: real-world numbers depend on the proxy too). Before =
the repository build; after = a scratch build of the same tree with the bundle changes, the zod switch and
`htmlLimitedBots` (proposals 1-2), run interleaved with the "before" server.

| Page | Performance | Accessibility | Best Practices | SEO | LCP | CLS | TBT |
|---|---|---|---|---|---|---|---|
| `/` before / after | 87 / **92** | 100 / 100 | 96 / **100** | 100 / 100 | 3.91 / 3.32 s | 0.001 / 0.001 | 24 / 27 ms |
| `/software` | 90 / **93** | 100 / 100 | 96 / **100** | 91 / **100** | 3.61 / 3.23 s | 0.002 / 0.002 | 49 / 29 ms |
| `/software/medical-billing` | 87 / **92** | 100 / 100 | 96 / **100** | 100 / 100 | 3.98 / 3.32 s | 0.001 / 0.001 | 32 / 19 ms |
| `/pricing` | 90 / **93** | 100 / 100 | 96 / **100** | 100 / 100 | 3.61 / 3.21 s | 0.004 / 0.004 | 43 / 15 ms |
| `/contact` | 91 / **93** | 100 / 100 | 96 / **100** | 91 / **100** | 3.46 / 3.17 s | 0.001 / 0.001 | 43 / 10 ms |

FCP was unchanged (1.2-1.7 s). What held the scores down and what changed:
- **Best Practices 96, every page**: "Issues were logged in the Issues panel", the CSP violation from Zod's eval probe
  (section 1, item 3). Fixed by the jitless switch.
- **SEO 91 on `/software` and `/contact`**: no meta description. Both pages are dynamic (search params, the form), and
  Next.js 15.2+ streams their metadata into `<body>` for any user agent outside its "HTML-limited bots" list, which
  includes Googlebot (checked with Chrome, Lighthouse and Googlebot user agents: description and canonical in
  `<body>` on `/software`, `/contact` and `/sign-in`). Their metadata is static, so streaming buys nothing: set
  `htmlLimitedBots: /.*/` in `next.config.ts` and every user agent gets it in `<head>` (verified on the scratch build).
- **LCP 3.5-4.0 s (simulated)**: the LCP element is the hero text, painted about 240 ms after navigation on localhost.
  Lighthouse's simulation charges everything fetched before that paint to LCP on a slow 4G link: the HTML (41 kB gzip
  on `/`, of which the RSC payload is 22 kB), the render-blocking CSS (20.6 kB), the preloaded Manrope font (41 kB) and
  the JavaScript chunks. Removing 79 kB of JavaScript took LCP to 3.2-3.3 s. Further options, not measured: inline the
  critical CSS (`experimental.inlineCss`, one round trip less but 20 kB more HTML per page), fewer font weights or
  `display: "optional"` for Manrope, the icon registry change from section 1 (28 kB), smaller RSC payloads (static
  copy in server components rather than props of client components).
- Remaining unscored items: `legacy-javascript` (11 KiB of Next.js 15's own polyfills, `Array.prototype.at` etc.; not
  configurable in 15.x), `bf-cache` on the dynamic pages (`Cache-Control: no-store` from Next.js), and
  `label-content-name-mismatch` (weight 0) on the header logo link, whose `aria-label` "Axiomatic Software Solutions —
  home" contains the visible "Axiomatic Software Solutions" in another letter case (WCAG 2.5.3 is met; no change
  needed).
- CLS stays at 0.001-0.004 and TBT under 50 ms: the pages do little main-thread work after hydration.

## Budgets
New work keeps these; check them with the scripts above before a release.

| What | Budget | Now (with the proposed changes) |
|---|---|---|
| Storefront first-load JS, downloaded (gzip, `perf-bundle.mjs --base`) | 230 kB; 260 kB on pages with forms | 208-221 kB; forms 244-256 kB |
| Storefront first-load JS, Next's column (`perf-bundle.mjs --dist=... --only=store --budget=210` exits 1 when over) | 210 kB | 107-201 kB |
| Portal and admin first-load JS (Next's column) | 300 kB | 171-288 kB |
| Lighthouse mobile on `/`, `/software`, `/software/<product>`, `/pricing`, `/contact` | Performance >= 90; Accessibility, Best Practices, SEO 100; CLS < 0.1; TBT < 200 ms | see section 5 |
| Device API (`/validate`), per process | >= 300 req/s per vCPU at p95 < 100 ms | 1,077 req/s at p95 80 ms (64 concurrent, this machine) |
| Postgres per device API call | < 1 ms | 0.1-0.3 ms at 3 lakh licenses |
| Portal page reads, largest account | < 50 ms | 2-21 ms (tuned settings) |
| Admin list or detail | < 200 ms at 3 lakh licenses | 14-186 ms except broad searches and the overview / reports (cache them) |
| Any statement | < 5 s (`DATABASE_STATEMENT_TIMEOUT_MS`) | yes |

## Proposed changes
Measured above on scratch copies. Status at the Phase 7 integration (2026-10-08): 1, 2, 4 and 5 are applied as
written (guarded by `tests/unit/perf-bundle-guards.test.ts` and `perf-zod-config.test.ts`); 6 is applied as
`node_args` from `AXS_HEAP_MB` (default 512) in `deploy/ecosystem.config.cjs` rather than `NODE_OPTIONS`, plus the
PostgreSQL settings in `deploy/README.md` and `docs/deploy-today.md` step 2.3; 3 (the index migration) waits for the
schema owner; 7 stays for later. In order of value:

1. **Storefront JavaScript** (`components/ui/button.tsx`, `badge.tsx`, `breadcrumb.tsx`, `card.tsx`: Radix deep
   entry; `lib/cart/store.ts`, `lib/compare/store.ts`: validators without Zod; `components/auth/account-menu-model.ts`,
   `auth-model.ts`, `components/store/account-menu.tsx`: name helpers; `instrumentation-client.ts`: the zod switch on
   the global object). -75 to -112 kB on storefront pages without forms (Next column; -79 kB downloaded on `/`),
   Best Practices 100.
2. **`next.config.ts`: `htmlLimitedBots: /.*/`** (metadata in `<head>` for every user agent): SEO 100.
3. **Index migration** (`prisma/migrations/<timestamp>_performance_indexes/migration.sql`, with the matching
   `@@index` lines in `schema.prisma`):
   ```sql
   -- Admin list sorts, report windows, a covering license-health index and trigram indexes for the contains-searches
   -- (docs/performance.md "Database at scale"). pg_trgm is a trusted extension: the database owner may create it.
   CREATE EXTENSION IF NOT EXISTS pg_trgm;

   CREATE INDEX "Order_createdAt_idx" ON "Order"("createdAt");
   CREATE INDEX "Order_paidAt_idx" ON "Order"("paidAt");
   CREATE INDEX "Invoice_issuedAt_idx" ON "Invoice"("issuedAt");
   CREATE INDEX "License_issuedAt_idx" ON "License"("issuedAt");
   CREATE INDEX "License_keyLast4_idx" ON "License"("keyLast4");
   CREATE INDEX "User_kind_idx" ON "User"("kind");

   DROP INDEX "License_status_expiresAt_idx";
   CREATE INDEX "License_status_expiresAt_productId_idx" ON "License"("status", "expiresAt", "productId");

   CREATE INDEX "License_id_trgm_idx" ON "License" USING GIN ("id" gin_trgm_ops);
   CREATE INDEX "Order_email_trgm_idx" ON "Order" USING GIN ("email" gin_trgm_ops);
   CREATE INDEX "User_email_trgm_idx" ON "User" USING GIN ("email" gin_trgm_ops);
   CREATE INDEX "User_name_trgm_idx" ON "User" USING GIN ("name" gin_trgm_ops);
   CREATE INDEX "BusinessAccount_legalName_trgm_idx" ON "BusinessAccount" USING GIN ("legalName" gin_trgm_ops);
   CREATE INDEX "DeviceActivation_name_trgm_idx" ON "DeviceActivation" USING GIN ("name" gin_trgm_ops);

   -- Room on each page for HOT presence updates; vacuum and analyze sooner (docs/scaling.md "The validate hot path").
   ALTER TABLE "DeviceActivation" SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.05);
   ```
   Schema: `Order` `@@index([createdAt])`, `@@index([paidAt])`,
   `@@index([email(ops: raw("gin_trgm_ops"))], type: Gin, map: "Order_email_trgm_idx")`;
   `Invoice` `@@index([issuedAt])`;
   `License` `@@index([issuedAt])`, `@@index([keyLast4])`, `@@index([status, expiresAt, productId])` in place of
   `@@index([status, expiresAt])`, `@@index([id(ops: raw("gin_trgm_ops"))], type: Gin, map: "License_id_trgm_idx")`;
   `User` `@@index([kind])` and the two GIN lines for `email` and `name`; `BusinessAccount` and `DeviceActivation` the
   GIN lines for `legalName` and `name`. The extension stays out of `schema.prisma` (no preview feature needed; Prisma
   ignores extensions and table storage parameters it does not manage). On today's small tables the migration takes
   well under a second; on large tables build indexes with `CREATE INDEX CONCURRENTLY` by hand instead (it cannot run
   inside a migration transaction).
4. **Admin license search** (`lib/admin/licenses/sql.ts` `licenseSearchSql`): a UNION of license ids per table. 2.3 s
   (1.3 s tuned) to 21 ms at 3 lakh licenses; also used by the Renewals search.
5. **Customers sorted by an order aggregate** (`lib/admin/customers/queries.ts` `selectCustomerPage`): page ids from
   the aggregate alone, then 25 full rows. 1.4 s to 0.19 s at 50,000 accounts.
6. **Production Postgres settings** (section 2) in the deploy guide, and **`NODE_OPTIONS=--max-old-space-size=512`** in
   `deploy/ecosystem.config.cjs` `env` (768 on 8 GB servers).
7. Later, by measurement: cache the admin overview, reports, license stats and unfiltered list totals for 60 s;
   denormalised customer aggregates past a few lakh accounts; the icon registry (28 kB per page); a 1.5 s Redis command
   timeout if `rate_limit_store_unavailable` appears in production without a Redis incident.
