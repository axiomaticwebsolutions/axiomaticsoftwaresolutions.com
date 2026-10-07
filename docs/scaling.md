# Scaling: license API, rate limits and downloads

Target (decisions.md "Scale target"): 25 lakh licenses, the device API as the hot path, ~1,000 req/s in the
Phase 7 load test. This note explains why the hot path stays cheap, what production needs (Redis, pooling, CDN),
what the local benchmark showed and what to measure on the real servers. The Phase 7 measurements (production build
under load, the database at 3 lakh licenses, Lighthouse, JavaScript per page), the capacity plan for 25 lakh licenses
and the performance budgets are in [`performance.md`](performance.md).

## Expected load
Apps call `/validate` at start-up and once a day, and keep working offline until `nextCheckBefore`
(`LICENSE_OFFLINE_GRACE_DAYS`, 7) plus a 30-day refresh window. With ~1.5 devices per license that is roughly
37 lakh devices and 4-11 million validations a day: 45-130 req/s on average. Shops open between 9 and 11 AM IST,
so the morning peak is several times the average; 1,000 req/s is the design point with headroom.

## The validate hot path (`lib/licensing/activation.ts` -> `validateActivation`)
Per request, in order:
1. Strict JSON body (8 KB cap) and the `X-App-Id` header.
2. Per-IP limit (60/min): one Redis Lua call, before any crypto, so one client cannot burn CPU.
3. EdDSA signature check of the activation token (jose, key imported once per process).
4. Per-license limit (30/min): one Redis Lua call.
5. One SQL statement: `License` by primary key plus a `LEFT JOIN LATERAL` to the newest active `DeviceActivation`
   for the fingerprint (index `DeviceActivation_licenseId_fingerprint_idx`).
6. `lastSeenAt`/`appVersion` are written at most once per 12 h per device (conditional `UPDATE ... WHERE
   lastSeenAt <= now - 12h`, atomic across servers). No `LicenseEvent`, audit or session writes, ever.
7. Published releases come from a 60 s per-process cache (`latestEligibleVersion`).
8. A fresh EdDSA token is signed and returned.

So a steady-state validation costs two Redis round trips, one indexed read and about 0.2 ms of signature CPU (Phase 7,
production build: about 0.9 ms of CPU per request in total, framework included, so one Node process serves about 1,100
validations/s on a fast core; Postgres spends 0.05 ms on the read at 3 lakh licenses). The presence write is about one
`UPDATE` per device per day, and almost all of them happen at the device's first start of the day (its previous write
is more than 12 h old): the 9-11 AM IST peak is mostly write traffic. Plan for about 500 `UPDATE`/s in that peak (37
lakh devices in about 2 hours). `lastSeenAt` and `appVersion` are not indexed, so the updates are HOT updates when the
pages have room: the Phase 7 migration should set `ALTER TABLE "DeviceActivation" SET (fillfactor = 90)` plus
per-table autovacuum settings (`autovacuum_vacuum_scale_factor = 0.02`, `autovacuum_analyze_scale_factor = 0.05`; part
of the index migration proposed in `performance.md`). Measured in Phase 7 on a production build: the first-of-day pass
(every request writes) ran 979 req/s against 1,077 req/s steady state on one process, so the write path costs about a
tenth. Measured in-process during the Phase 4 review (Redis store, localhost Postgres, 600 devices, 10 concurrent):
the first-of-day pass with the `UPDATE` ran 2,966 req/s (p50 3.2 ms), the steady state 5,696 req/s (p50 1.7 ms); the
write path costs about twice as much. Activation and deactivation are rare and may write freely (row lock on the
license, device row, `LicenseEvent`, account activity).

## Rate limits: Redis is required in production
- Store: `lib/auth/rate-limit-redis.ts` (`RedisRateLimitStore`, ioredis). Fixed windows; one key per bucket,
  `axs:rl:<flow>:<dimension>:<hashed id>`, whose TTL is the window. `increment`, `consume` and `refund` are single
  Lua scripts (INCR + PEXPIRE-if-no-expiry; consume counts only below the limit; refund never goes below 0), so
  limits hold across all app servers and under concurrency. Redis's clock owns the window; Retry-After is the
  key's remaining TTL. Expired keys vanish on their own (no purge job).
- Registration: `instrumentation.ts` validates the environment at server start (production refuses to start
  without `REDIS_URL`) and calls `installRedisRateLimitStore()` once per process. Logs:
  `rate_limit_store_registered`, `rate_limit_store_connected`, `rate_limit_store_unavailable` (at most once per
  10 s per process), `rate_limit_store_recovered`.
- Why not Postgres in production: the Postgres store writes a row per counted hit. Two limits per validation at
  1,000 req/s would be 2,000 upserts/s of pure WAL churn and row-lock contention on hot keys. Measured locally,
  a Postgres `consume()` costs 534 us (105 us amortised at 20 concurrent) against 84 us (12 us) for Redis.
- Failure policy (Redis unreachable, slow or erroring; connect timeout 2 s, command timeout 500 ms, fail-fast
  while reconnecting):

| Operation | Used by | When Redis is down |
|---|---|---|
| `consume()` | `attempt()`, `enforceAttempts()`: sign-in, codes, key reveal, password checks, payment returns, activate, validate, deactivate | **Fail closed**: 503 `unavailable`, Retry-After 5 |
| `get()` | `peek()` (read by those flows) | Fail closed: 503 |
| `increment()` | `hit()`: register, contact, quotes/coupons, order status/actions, invoice PDFs, downloads, webhook bookkeeping | Fail open, degraded: counted in process memory (bounded), so each server still enforces the limit |
| `refund()`, `delete()` | success paths | Best effort: the attempt stays counted (strict side) |

  Devices ride out a Redis outage on their signed token (7-day grace), so a 503 from `/validate` costs no
  customer anything; sign-in and activation pause until Redis is back.
- Managed Redis: ElastiCache for Redis 7 / Valkey in ap-south-1, Multi-AZ with automatic failover, TLS
  (`rediss://` with an AUTH token in the URL), cluster mode disabled (single-key scripts would also work with
  cluster mode). Memory is small: a bucket is ~100 bytes and lives at most one window (most are 1-15 min), so
  even 200,000 live buckets are ~20 MB. Use a dedicated instance or logical database, `maxmemory-policy
  volatile-ttl`, and alarm on memory > 70 %, evictions > 0, CPU, and replication lag.
- Development: without `REDIS_URL` the Postgres buckets are used. To run against Redis locally (Memurai on
  127.0.0.1:6379), start the server with `REDIS_URL=redis://127.0.0.1:6379`. `scripts/check-purchase.mjs` resets the
  shared Postgres "unknown"-IP buckets only; with Redis those keys live in Redis instead.
- Next.js loads `instrumentation.ts` and the route handlers as separate module graphs. The registered store is
  therefore kept on `globalThis` (`setRateLimitStore`), and `ApiError` uses a brand check for `instanceof`, so the
  store's 503 is rendered as a 503 by `errorResponse()` in every route.

## Database indexes on the device API
| Query | Index | Plan (checked with `EXPLAIN`, `enable_seqscan = off` on the small dev tables) |
|---|---|---|
| Activate: license by key, `FOR UPDATE` | `License_keyHash_key` (unique) | Index Scan + LockRows |
| Activate: count active devices | `DeviceActivation_licenseId_fingerprint_idx` (prefix `licenseId`) | Index Scan |
| Validate / deactivate: license + device | `License_pkey`, `DeviceActivation_licenseId_fingerprint_idx` | Nested Loop: Index Scan on both, filter `deactivatedAt IS NULL` |
| Downloads: account licenses, releases | `License_accountId_idx` or `License_productId_idx` (planner choice), `Release_productId_status_idx` | Index Scan |
| Releases for the portal and order page: newest per product (`LIMIT 500` headers per product), then the chosen ids | `Release_productId_status_idx`, `Release_pkey` | Index Scan |
| Portal license list / detail: active devices per listed license (`countActiveDevices`, `GROUP BY licenseId` with `licenseId IN (...)`) | `DeviceActivation_licenseId_fingerprint_idx` (prefix) | Index or Bitmap Index Scan |
| Portal device fleet: devices, stale count and active devices per license of one account (relation filter on `License.accountId`) | `License_accountId_idx`, then `DeviceActivation_licenseId_fingerprint_idx` | Nested Loop with index scans with SSD planner settings (`random_page_cost=1.1`); with the stock 4 the planner scans all devices (257 ms against 22 ms for a 4,000-license account at 5 lakh devices, `performance.md`) |
| Activation churn cap: activations of the last 30 days for the locked license | `DeviceActivation_licenseId_fingerprint_idx` (prefix), filter `activatedAt` | Index Scan (rows of one license) |
| Download log | `DownloadEvent_licenseId_createdAt_idx` | Index Scan |

The dev tables are tiny, so the planner picks sequential scans there; always check plans against production-sized
data. `tests/db/portal-query-plans.test.ts` loads 20,000 licenses and 40,000 devices, EXPLAINs the SQL the portal read
models send and fails on any unbounded scan of `DeviceActivation`. Never use Prisma's `_count` of `devices` on a
license list: it compiles to a `GROUP BY` over the whole `DeviceActivation` table joined afterwards (measured in the
Phase 4 review on 3 lakh licenses / 6 lakh devices: a 450,000-row sequential scan, a 15 MB on-disk hash aggregate and
about 700 ms per request, growing with the table). If deactivated devices pile up, a partial index `ON
"DeviceActivation" ("licenseId", "fingerprint") WHERE "deactivatedAt" IS NULL` keeps the validate lookup to live rows.
Phase 7 decision: not needed now (at 5 lakh devices with 10 % deactivated the lookup takes 0.05 ms); revisit if
deactivated rows outnumber live ones.

Phase 7 ran every read path of the app against 3 lakh licenses, 5 lakh devices and 2 lakh orders
(`scripts/perf-db.mjs`, results in `performance.md` "Database at scale"). The device API and the portal stay
index-bound; the admin console needed indexes on `Order.createdAt`, `Order.paidAt`, `Invoice.issuedAt`,
`License.issuedAt`, `License.keyLast4`, `User.kind`, `License(status, expiresAt, productId)` and trigram (`pg_trgm`)
indexes for its contains-searches, plus two query rewrites (license search, customers sorted by lifetime value). They
are proposed there with the exact migration.

## Connection pooling
- Each app process holds one node-postgres pool through `@prisma/adapter-pg`, built by `createPrismaClient()` in
  `lib/db.ts` from three settings (validated at start-up by `lib/env.ts`):

| Variable | Default | Effect |
|---|---|---|
| `DATABASE_POOL_MAX` | 10 | Connections per process (pg `max`). Server connections = processes x this; keep it well below Postgres `max_connections` (RDS sizes it from memory). |
| `DATABASE_POOL_TIMEOUT_MS` | 5000 | Longest wait for a pooled connection, or to open a new one (pg `connectionTimeoutMillis`). pg-pool alone waits forever. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 5000 | Server-side `statement_timeout`, sent as a connection startup parameter; 0 = leave the server setting. Lock waits count too. A query that needs longer must `SET LOCAL statement_timeout` in its own transaction. |

- Past either bound the request fails at once and `errorResponse()` (`lib/http.ts`, classifier
  `databaseUnavailableReason()` in `lib/db-errors.ts`) answers `503 unavailable` with `Retry-After: 5`, logging
  `database_unavailable` at most once per 10 s per process. Without the bounds, a slow query or an RDS Multi-AZ
  failover (60-120 s) made every request wait for a connection without limit (measured in the Phase 4 review: a
  validation waited 3.8 s behind 10 busy connections and returned no error), so work piled up and ran after the apps
  had already timed out (15 s) and retried. Interactive transactions keep `maxWait` at or above the pool timeout; the
  pool timeout fires first.
- Postgres 57014 (statement timeout), 53300, 55P03, 08xxx and 57P01-57P03 map to the same 503. Deadlocks and
  serialization failures stay 500 (they point at a bug).
- Up to ~10 processes need no pooler. Beyond that, or with autoscaling, put **RDS Proxy** or **PgBouncer**
  (transaction mode) between the app and Postgres and point `DATABASE_URL` at it:
  - Interactive transactions (`SELECT ... FOR UPDATE`, counters, webhook processing) keep one server connection for
    the whole transaction, which transaction pooling preserves.
  - node-postgres uses unnamed prepared statements, which work with PgBouncer transaction mode.
  - Never put `?schema=` on a production URL: `lib/db.ts` turns it into a `search_path` startup option, which pins
    every RDS Proxy connection (it exists for test isolation only).
  - PgBouncer refuses startup parameters it does not track: set `DATABASE_STATEMENT_TIMEOUT_MS=0` there and put the
    timeout on the role instead (`ALTER ROLE app SET statement_timeout = '10s'`). Check in Phase 7 whether RDS Proxy
    pins on the `statement_timeout` startup parameter; if it does, use the role setting there too.

## Horizontal scaling
- App servers are stateless: sessions in Postgres, rate limits in Redis, files in S3, emails through the outbox
  and cron. Any number of containers can run behind the load balancer; set `TRUSTED_PROXY_HOPS` to the proxies
  that append to X-Forwarded-For (ALB = 1, CloudFront + ALB = 2), otherwise every client lands in the same
  per-IP bucket.
- Node runs one thread per process: run one process per vCPU (one container per vCPU, or one task per vCPU), and
  autoscale on CPU (about 60 %) and ALB target response time.
- Per-process caches are small and short-lived: imported signing keys, published releases (60 s; a newly
  published release reaches every server within a minute), the Redis client (one connection per process).
- Serve the device API as its own ALB target group or service (`api.axiomatic.example` in the contract) from the
  same image, so storefront spikes and the morning validation peak scale independently.
- Shedding is safe on the device API: 429/503 answers just make the app retry later, and it keeps working on its
  signed token in the meantime. Load shedding depends on the pool bounds above (`DATABASE_POOL_TIMEOUT_MS`,
  `DATABASE_STATEMENT_TIMEOUT_MS`): they turn a saturated or failing-over database into fast 503s instead of a
  growing queue in every process. Size `DATABASE_POOL_MAX` x processes against `max_connections` (or the proxy).

## Downloads through the CDN, never through the app
- `POST /api/account/downloads` and `POST /api/orders/:id/downloads` only check entitlement, write a
  `DownloadEvent` and return a presigned GET (TTL = min(setting, `DOWNLOAD_LINK_TTL_SECONDS`, 600 s)). The
  installer bytes go straight from S3 to the customer; app servers never stream files.
- Production: private bucket (Block Public Access on), CloudFront in front with Origin Access Control, and
  CloudFront signed URLs (a key group) instead of S3 presigning, so installers are cached at Indian edge
  locations and egress is cheaper. That is a driver option in `lib/storage/s3.ts` (Phase 7); the API and the TTL
  rules stay the same. Keep `Content-Disposition: attachment` and the `sha256` from `ReleaseFile` on the download
  page so customers can verify installers.
- Download links are limited to 30 per hour per user (or per guest order) and every issuance is logged.

## Partitioning plan for append-only tables
`LicenseEvent`, `AuditLog`, `WebhookDelivery`, `DownloadEvent` and `AccountActivity` only grow. Rough volumes at
25 lakh licenses: `LicenseEvent` 5-10 rows per license per year (issue, activations, renewals) = 1.2-2.5 crore rows a
year; `DownloadEvent` and `AuditLog` far fewer; `WebhookDelivery` about two rows per order. Single tables with the
existing `(…, createdAt)` indexes are fine for the first years. Partition a table when it passes ~5 crore rows or
when retention deletes start to hurt vacuum:
1. Native declarative partitioning `PARTITION BY RANGE ("createdAt")` (`receivedAt` for `WebhookDelivery`), one
   partition per month. The primary key must include the partition key: `@@id([id, createdAt])` (schema change).
   Nothing references these tables by foreign key, so they can be partitioned without touching other tables.
2. Migration: create the partitioned table, attach monthly partitions, copy in batches, swap names in a short
   maintenance window (or partition from day one in a quiet period). `pg_partman` (supported on RDS) creates future
   partitions and detaches expired ones.
3. Queries must filter on the partition key to prune: admin lists and exports are already date-ordered and should
   always carry a date range; per-license history keeps `(licenseId, createdAt)` as a local index.
4. Retention is a business and legal decision (set it with the CA and counsel): e.g. keep `AuditLog` for the GST
   record-keeping period, `WebhookDelivery` for about 13 months; dropping a monthly partition is instant and leaves
   no bloat.
`DeviceActivation` is not append-only but keeps deactivated rows; archive those older than a few years if the table
grows large. `RateLimitBucket` stays empty in production (Redis).

## Local benchmark (`scripts/bench-validate.mjs`)
**Phase 7, production build** (2026-10-07; full method and tables in `performance.md` "Device API under load"):
`next start` with `REDIS_URL` and `TRUSTED_PROXY_HOPS=1`, same machine, `--spoof-ip`, 5 s warm-up, 30 s runs.

| Run | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|
| 16 concurrent, 1 process | 1,139.5 req/s | 12.4 ms | 17.6 ms | 23.8 ms |
| 64 concurrent, 1 process | 1,076.7 req/s | 54.2 ms | 79.7 ms | 201.0 ms |
| 128 concurrent, 1 process | 1,056.9 req/s | 112.4 ms | 166.9 ms | 316.8 ms |
| 128 concurrent, 3 processes | 2,667.8 req/s | 27.0 ms | 121.9 ms | 146.7 ms |
| first of the day (`--stale`), 64 concurrent, 1 process | 978.8 req/s | 61.2 ms | 89.5 ms | 111.8 ms |
| activation burst, 16 concurrent, 1 process | about 500-600 req/s | 25-29 ms | 34-47 ms | 43-149 ms |

One process saturates one core at about 1,100 validations/s (0.9 ms of CPU each, mostly framework). Under full
saturation 0.01-0.06 % of requests got `503 unavailable` from Redis command timeouts (500 ms) caused by stalls of the
Node process itself (every run kept the process at full CPU). Cap the heap in PM2 (`--max-old-space-size=512`: 0.5 GB
RSS instead of 1.15 GB, same throughput). Capacity plan for 25 lakh licenses: `performance.md` "Capacity at 25 lakh
licenses".

Earlier, development server (Phase 4): Windows 11, Ryzen 9 9900X (12 cores / 24 threads) shared with other work (about
65 % CPU busy during the runs), Node 24, `next dev` (development mode, one process) on port 3104 with `REDIS_URL` set
(Memurai 4.1 / Redis 7.2 on localhost) and `TRUSTED_PROXY_HOPS=1`, embedded PostgreSQL 17 on localhost. Each run
issued throwaway licenses, activated one device per license, used `--spoof-ip`, and deleted everything afterwards.

| Concurrency | Licenses | Result (10 s) | p50 | p95 | p99 | Statuses |
|---|---|---|---|---|---|---|
| 4 | 60 | 54.7 req/s | 64 ms | 104 ms | 330 ms | 200 x 550 |
| 10 | 100 | 94.3 / 94.9 req/s (two runs) | 97 ms | 139-142 ms | 371-378 ms | 200 x 949 / 954 |
| 20 | 150 | 104.9 req/s | 162 ms | 437 ms | 753 ms | 200 x 1,063 |

- Every response was `200 { valid: true }`; activations all `200`.
- These numbers measure `next dev` on a busy machine, not the hot path. The like-for-like floor is the same route
  doing no I/O: re-run in the Phase 4 review on one `next dev` server (Redis, `TRUSTED_PROXY_HOPS=1`, `--spoof-ip`),
  `/validate` without `X-App-Id` (400 before any I/O) reached 64.5 req/s at concurrency 1 (p50 13.4 ms), 108.8 at 10
  and 170.7 at 20, against 48.7 / 93.3 / 115.0 req/s for full validations (all 200). (The order-status route
  quoted here before was slower than `/validate` itself, so it was no baseline.) A production build (`next start`)
  is about ten times faster (Phase 7 table above).
- In-process, without the HTTP layer (Vitest, Redis store, localhost Postgres, 1,000 licenses; Phase 4 review): a
  full validation took 0.77 ms serially (1,270 req/s at concurrency 1), 4,347 req/s at 4 and about 6,400-7,400
  req/s saturated on one Node thread; 2,972-3,258 req/s with the Postgres rate-limit store. The hot-path code is
  about 1 ms; the 100-130 req/s ceiling above is the dev server.
- Without `--spoof-ip`, one license, 10 workers for 5 s: 29 x 200 and 494 x 429 `too_many_attempts` (the
  30/min per-license limit, enforced through Redis).
- Component costs measured in-process (Node 24, localhost services):

| Step | Sequential | 20 concurrent (amortised) |
|---|---|---|
| EdDSA sign activation token | 88 us | - |
| EdDSA verify activation token | 121 us | - |
| Redis `consume()` (Lua) | 84 us | 12 us |
| Postgres `consume()` (row upsert, dev store) | 534 us | 105 us |
| Validate SELECT (license + device) | 288 us | 60 us |

  Signature work is ~0.2 ms of CPU per validation; the rest is I/O wait. Per-vCPU capacity in production is set by
  the framework (request parsing, routing, JSON), not by the hot-path code; Phase 7 item 1 measures it.
- `--stale` moves the bench devices' `lastSeenAt` 13 h back after activation, so the first validation of each device
  takes the presence-write path (the morning case); the script reports that first pass separately. Use at least as
  many `--licenses` as requests to make every request a write.
- Failure policy, checked end to end with `REDIS_URL` pointing at a closed port: validate, activate and sign-in
  answered `503 unavailable` (Retry-After 5, no-store); the order-status route kept serving through the
  per-process window; the outage was logged once.

Running it:
```
# your own production server (see performance.md "Method"), never --spoof-ip against the shared dev server
node scripts/bench-validate.mjs --base=http://localhost:3150 --concurrency=64 --duration=30 --warmup=5 \
  --licenses=2500 --activate-concurrency=16 --spoof-ip --json
# several processes, round robin like Nginx in front of PM2 cluster mode
node scripts/bench-validate.mjs --base=http://localhost:3150,http://localhost:3153 --concurrency=128 --licenses=6000 --spoof-ip
```
Licenses needed for an all-200 run: rate x min(warmup + duration, 60) / 30 (the per-license limit). The script never prints
keys or tokens. For a remote target set `BENCH_LICENSE_KEYS` (comma-separated keys) instead of issuing locally; the
bench devices are deactivated afterwards.

## Phase 7: what to measure on the real servers
Phase 7 measured items 1 and 2 on one development machine (`performance.md`): about 1,100 validations/s per
process, 2,668 with three, and the morning write path at about 90 % of that. Repeat them on the production servers
before relying on the capacity plan, with the Postgres settings and the PM2 heap cap from `performance.md` in place.
1. Per-container capacity: production build, one container of known size, ramp `/validate` until p95 > 100 ms.
   Record req/s per vCPU and a CPU profile (signature vs framework vs JSON).
2. Sustained load: ~1,000 req/s for 30 minutes across thousands of licenses and realistic client IPs (a k6 or
   distributed bench-validate run with `BENCH_LICENSE_KEYS`), plus a morning-storm spike (3x for 5 minutes) with
   stale `lastSeenAt` (every device's first check of the day writes; `bench-validate --stale` locally).
   Targets: p95 < 100 ms and p99 < 300 ms at the ALB, 5xx < 0.1 %, no 429 for well-behaved devices.
3. Client IPs: confirm `TRUSTED_PROXY_HOPS` yields real addresses (log `ipPrefix` samples). Watch 429 rates per IP:
   many shops sit behind carrier-grade NAT on mobile networks, and 60 validations/min per IPv4 address (IPv6 is
   bucketed per /64) must hold at the morning peak; adjust `RATE_LIMITS.validateIp` if real traffic needs it.
4. Redis: command latency p99, CPU, connections (one per app process), memory, evictions (must stay 0), and a
   Multi-AZ failover drill: measure the 503 window for sign-in, activation and validation and confirm the
   `rate_limit_store_recovered` log line.
5. Postgres (settings: `performance.md` "Postgres settings"): connections and pool wait time, validate SELECT p95
   (`pg_stat_statements`), cache hit ratio (> 99 %),
   write IOPS (the `lastSeenAt` updates are about one per device per day, almost all in the 9-11 AM peak: ~500/s),
   HOT-update ratio on `DeviceActivation` (`pg_stat_user_tables.n_tup_hot_upd`), autovacuum on `DeviceActivation`,
   table growth of the append-only tables (decide on partitioning from real numbers).
6. Downloads: CloudFront cache hit ratio, egress, signed-URL expiry behaviour, `DownloadEvent` rate.
7. Fault injection: Redis down, Postgres failover, one app container killed under load; the apps must keep
   working offline throughout.
