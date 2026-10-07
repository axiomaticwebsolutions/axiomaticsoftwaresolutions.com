/**
 * Database at scale (docs/performance.md "Database at scale"). Dev tool: builds a scratch schema in the development
 * database, fills it with synthetic production-sized data, runs the app's own read paths against it and prints
 * EXPLAIN (ANALYZE, BUFFERS) of every statement they send. Never touches any other schema.
 *
 *   node scripts/perf-db.mjs create  [--schema=perf_<ts>] [--scale=1]   schema + migrations + catalog copy + data
 *   node scripts/perf-db.mjs explain --schema=perf_x [--only=device,portal,admin,jobs] [--out=dir] [--plans]
 *   node scripts/perf-db.mjs indexes --schema=perf_x [--undo]            apply (or remove) PROPOSED_INDEXES
 *   node scripts/perf-db.mjs drop    --schema=perf_x
 *
 * Connection: PERF_DATABASE_URL, else DATABASE_URL from .env.local (loaded like Next.js does); `?schema=` is
 * replaced by the scratch schema. Schema names must start with `perf_`. At --scale=1 the data is 50,000 accounts,
 * 200,000 orders, 300,000 licenses, 500,000 devices, 1,000,000 license events, 300,000 audit rows, 500,000 account
 * activity rows, 400,000 webhook deliveries, 30,000 tickets and smaller tables; account `acc_1` is the large customer
 * (4,000 licenses, about 6,000 devices, 2,000 orders, 20,000 activity rows). The catalog (categories, products,
 * plans, releases, settings, templates, FAQs) is copied from the source schema so the app's queries find real plans.
 *
 * `explain` loads the app modules through tsx (as scripts/bench-validate.mjs does), points them at a capturing Prisma
 * client (tests/support/query-capture.ts), runs each scenario, then re-runs every captured statement under
 * EXPLAIN (ANALYZE, BUFFERS) inside a transaction that is rolled back (warm cache: the scenario already read the
 * pages). It prints one line per statement: execution ms, rows, shared buffers hit/read, and the plan's scans, with
 * `SEQ` marking a sequential scan of a table over 10,000 rows and `DISK` an on-disk sort or hash. --plans prints the
 * text plans; --out=dir writes them to files. Rate-limit bookkeeping statements are left out. Parallel query is off
 * for the EXPLAINs unless --parallel (Windows starts each worker as a process); --settings="random_page_cost=1.1,..."
 * applies planner settings to them (e.g. the production values in docs/performance.md).
 */
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import nextEnv from "@next/env";
import pg from "pg";

const opt = Object.fromEntries(
  process.argv.slice(3).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);
const command = process.argv[2];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

nextEnv.loadEnvConfig(ROOT, true, { info: () => {}, error: (...args) => console.error(...args) });

const SCHEMA_RE = /^perf_[a-z0-9_]{1,40}$/;
const schema = opt.schema ?? (command === "create" ? `perf_${Date.now().toString(36)}` : undefined);
if (!["create", "explain", "indexes", "drop"].includes(command ?? "") || !schema || !SCHEMA_RE.test(schema)) {
  console.error("Usage: node scripts/perf-db.mjs create|explain|indexes|drop --schema=perf_<name> (see the header).");
  process.exit(2);
}
const baseUrl = process.env.PERF_DATABASE_URL ?? process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL is not set (.env.local).");
  process.exit(2);
}

/** The source schema of the catalog copy: the base URL's ?schema=, else public. */
const sourceSchema = new URL(baseUrl).searchParams.get("schema") || "public";
function urlFor(target) {
  const url = new URL(baseUrl);
  url.searchParams.set("schema", target);
  return url.toString();
}
function plainUrl() {
  const url = new URL(baseUrl);
  url.searchParams.delete("schema");
  return url.toString();
}

const SCALE = Math.max(0.01, Math.min(10, Number(opt.scale ?? 1) || 1));
const n = (count) => Math.max(1, Math.round(count * SCALE));
const ms = (t0) => `${((performance.now() - t0) / 1000).toFixed(1)} s`;

/** A pg client in UTC (timestamp(3) columns hold UTC, as Prisma writes them), optionally on the scratch schema. */
async function connect(searchPath) {
  const options = ["-c TimeZone=UTC", searchPath ? `-c search_path="${searchPath}"` : ""].filter(Boolean).join(" ");
  const client = new pg.Client({ connectionString: plainUrl(), options });
  await client.connect();
  return client;
}

// ---------- create ----------

const CATALOG_TABLES = ["Category", "Product", "Plan", "Release", "ReleaseFile", "SiteSetting", "NotificationTemplate", "Faq"];
const STATES = "ARRAY['Maharashtra','Karnataka','Tamil Nadu','Gujarat','Delhi','Uttar Pradesh','West Bengal','Kerala','Telangana','Rajasthan']";

/** Synthetic data, one statement per step. Deterministic ids (acc_1, usr_1, AX-100001, LIC-100001, ...). */
function dataStatements() {
  const ACC = n(50_000);
  const EXTRA = n(10_000);
  const ORD = n(200_000);
  const LIC = n(300_000);
  const DEV = n(500_000);
  const big = Math.min(2_000, ORD);
  const ago = (days) => `now() - random() * interval '${days} days'`;
  return [
    ["seed", "SELECT setseed(0.42)"],
    [
      "plans (temp)",
      `CREATE TEMP TABLE perf_plan AS
       SELECT (row_number() OVER (ORDER BY id))::int - 1 AS idx, id, "productId", type::text AS type, "interval"::text AS ivl,
              COALESCE("deviceLimit", 1) AS dl, "pricePaise" AS price
       FROM "Plan" WHERE NOT archived AND type IN ('ANNUAL', 'ONE_TIME', 'SUBSCRIPTION', 'TRIAL')`,
    ],
    [
      "staff users",
      `INSERT INTO "User" (id, kind, email, name, "emailVerifiedAt", "staffRole", "staffStatus", "twoStepEnabled", "updatedAt")
       SELECT 'stf_' || i, 'STAFF', 'perf-staff-' || i || '@example.test', 'Perf Staff ' || i, now(),
              (ARRAY['OWNER','ADMIN','SUPPORT','FINANCE'])[1 + i % 4]::"StaffRole", 'ACTIVE', true, now()
       FROM generate_series(1, 12) i`,
    ],
    [
      "accounts",
      `INSERT INTO "BusinessAccount" (id, "legalName", gstin, address, city, state, pin, "createdAt", "updatedAt")
       SELECT 'acc_' || i, 'Perf Business ' || i,
              CASE WHEN i % 3 = 0 THEN '27ABCDE' || lpad((i % 10000)::text, 4, '0') || 'F1Z5' END,
              'Perf address ' || i, 'Pune', (${STATES})[1 + i % 10], '411001', ${ago(1095)}, now()
       FROM generate_series(1, ${ACC}) i`,
    ],
    [
      "customer users",
      `INSERT INTO "User" (id, email, name, "emailVerifiedAt", "createdAt", "updatedAt")
       SELECT 'usr_' || i, 'perf-owner-' || i || '@example.test', 'Perf Owner ' || i, now(), ${ago(1095)}, now()
       FROM generate_series(1, ${ACC + EXTRA}) i`,
    ],
    [
      "members",
      `INSERT INTO "AccountMember" (id, "accountId", "userId", role)
       SELECT 'mem_' || i, 'acc_' || CASE WHEN i <= ${ACC} THEN i ELSE 1 + (i::bigint * 7919) % ${ACC} END, 'usr_' || i,
              (CASE WHEN i <= ${ACC} THEN 'OWNER' WHEN i % 2 = 0 THEN 'BILLING' ELSE 'TECHNICAL' END)::"TeamRole"
       FROM generate_series(1, ${ACC + EXTRA}) i`,
    ],
    [
      "orders (temp)",
      `CREATE TEMP TABLE perf_order AS
       SELECT i, CASE WHEN i <= ${big} THEN 1 WHEN i % 7 = 0 THEN NULL ELSE 1 + floor(random() * ${ACC})::int END AS acc,
              ${ago(1095)} AS created, i % (SELECT count(*) FROM perf_plan)::int AS plan_idx,
              (CASE WHEN r < 0.80 THEN 'PAID' WHEN r < 0.86 THEN 'FAILED' WHEN r < 0.92 THEN 'CANCELED'
                    WHEN r < 0.95 THEN 'AWAITING_PAYMENT' WHEN r < 0.96 THEN 'PENDING' WHEN r < 0.98 THEN 'REFUNDED'
                    WHEN r < 0.99 THEN 'PARTIALLY_REFUNDED' WHEN r < 0.995 THEN 'REVIEW' ELSE 'CONFIRMING' END) AS status
       FROM (SELECT i, random() AS r FROM generate_series(1, ${ORD}) i) s`,
    ],
    [
      "orders",
      `INSERT INTO "Order" (id, "accountId", "placedByUserId", email, billing, status, "subtotalPaise", "taxablePaise",
              "igstPaise", "totalPaise", "placeOfSupply", "createdAt", "updatedAt", "paidAt", "refundedAt", "termsAcceptedAt", "termsVersion")
       SELECT 'AX-' || (100000 + o.i), 'acc_' || o.acc, 'usr_' || o.acc,
              COALESCE('perf-owner-' || o.acc, 'perf-guest-' || o.i) || '@example.test',
              jsonb_build_object('name', 'Perf Buyer ' || o.i, 'business', 'Perf Business ' || COALESCE(o.acc, 0),
                'email', COALESCE('perf-owner-' || o.acc, 'perf-guest-' || o.i) || '@example.test', 'phone', '9000000000',
                'address', 'Perf address', 'city', 'Pune', 'state', 'Maharashtra', 'pin', '411001', 'gstin', NULL),
              o.status::"OrderStatus", p.price, p.price, round(p.price * 0.18), p.price + round(p.price * 0.18), 'Karnataka',
              o.created, o.created,
              CASE WHEN o.status IN ('PAID','REFUNDED','PARTIALLY_REFUNDED','REVIEW') THEN o.created + interval '2 minutes' END,
              CASE WHEN o.status = 'REFUNDED' THEN o.created + interval '3 days' END, o.created, '2026-10'
       FROM perf_order o JOIN perf_plan p ON p.idx = o.plan_idx`,
    ],
    [
      "order items",
      `INSERT INTO "OrderItem" (id, "orderId", "planId", kind, quantity, "unitPricePaise", "taxablePaise", "taxPaise",
              "issuedLicenseId", "fulfilledAt")
       SELECT 'oi_' || o.i, 'AX-' || (100000 + o.i), p.id, 'NEW', 1, p.price, p.price, round(p.price * 0.18),
              CASE WHEN o.status IN ('PAID','REFUNDED','PARTIALLY_REFUNDED') AND o.i <= ${LIC} THEN 'LIC-' || (100000 + o.i) END,
              CASE WHEN o.status IN ('PAID','REFUNDED','PARTIALLY_REFUNDED') THEN o.created END
       FROM perf_order o JOIN perf_plan p ON p.idx = o.plan_idx`,
    ],
    [
      "renewal items",
      `INSERT INTO "OrderItem" (id, "orderId", "planId", kind, quantity, "unitPricePaise", "taxablePaise", "taxPaise",
              "targetLicenseId", "fulfilledAt")
       SELECT 'oir_' || o.i, 'AX-' || (100000 + o.i), p.id, 'RENEWAL', 1, p.price, p.price, round(p.price * 0.18),
              'LIC-' || (100001 + (o.i::bigint * 31) % ${LIC}), o.created
       FROM perf_order o JOIN perf_plan p ON p.idx = o.plan_idx
       WHERE o.i % 5 = 0 AND p.type IN ('ANNUAL', 'SUBSCRIPTION')`,
    ],
    [
      "payments",
      `INSERT INTO "Payment" (id, "orderId", provider, "providerOrderId", "providerPaymentId", method, "amountPaise", status,
              "createdAt", "capturedAt")
       SELECT 'pay_' || o.i, 'AX-' || (100000 + o.i), 'razorpay', 'order_perf' || o.i,
              CASE WHEN cap THEN 'pay_perf' || o.i END, (ARRAY['UPI','Card','Net banking'])[1 + o.i % 3],
              p.price + round(p.price * 0.18),
              (CASE WHEN cap THEN 'CAPTURED' WHEN o.status = 'FAILED' THEN 'FAILED' WHEN o.status = 'CANCELED' THEN 'CANCELED'
                    ELSE 'CREATED' END)::"PaymentStatus",
              o.created, CASE WHEN cap THEN o.created + interval '2 minutes' END
       FROM perf_order o JOIN perf_plan p ON p.idx = o.plan_idx
       CROSS JOIN LATERAL (SELECT o.status IN ('PAID','REFUNDED','PARTIALLY_REFUNDED','REVIEW') AS cap) c`,
    ],
    [
      "invoices",
      `INSERT INTO "Invoice" (id, number, "orderId", seller, "issuedAt")
       SELECT 'inv_' || o.i, 'AXS/P/' || o.i, 'AX-' || (100000 + o.i),
              '{"legalName":"Perf seller","gstin":"27AAAAA0000A1Z5","state":"Maharashtra","address":"Perf","city":"Pune","pin":"411001"}'::jsonb,
              o.created + interval '2 minutes'
       FROM perf_order o WHERE o.status IN ('PAID','REFUNDED','PARTIALLY_REFUNDED')`,
    ],
    [
      "refunds",
      `INSERT INTO "Refund" (id, "paymentId", "providerRefundId", "amountPaise", reason, "createdById", "createdAt",
              "creditNoteNo", status, "processedAt")
       SELECT 'ref_' || o.i, 'pay_' || o.i, 'rfnd_perf' || o.i,
              CASE WHEN o.status = 'REFUNDED' THEN p.price + round(p.price * 0.18) ELSE (p.price + round(p.price * 0.18)) / 2 END,
              'Perf refund', 'stf_4', o.created + interval '3 days', 'AXC/P/' || o.i, 'PROCESSED', o.created + interval '3 days'
       FROM perf_order o JOIN perf_plan p ON p.idx = o.plan_idx WHERE o.status IN ('REFUNDED','PARTIALLY_REFUNDED')`,
    ],
    [
      "licenses",
      `INSERT INTO "License" (id, "accountId", "productId", "planId", "orderId", "keyHash", "keyCiphertext", "keyLast4",
              "keyDeliveredAt", status, "issuedAt", "expiresAt", "updatesUntil", "deviceLimit", "resetsYear", "revokedAt")
       SELECT 'LIC-' || (100000 + l.i), 'acc_' || o.acc, p."productId", p.id, 'AX-' || (100000 + o.i),
              encode(sha256(('perf-key-' || l.i)::bytea), 'hex'), 'v1.perf.perf.perf', upper(substr(md5(l.i::text), 1, 4)),
              o.created, st.status::"LicenseStatus", o.created, t.expires, COALESCE(t.expires, o.created + interval '365 days'),
              p.dl, 2026, CASE WHEN st.status = 'REVOKED' THEN o.created + interval '30 days' END
       FROM (SELECT i, random() AS r, random() AS r2 FROM generate_series(1, ${LIC}) i) l
       JOIN perf_order o ON o.i = 1 + (l.i - 1) % ${ORD}
       JOIN perf_plan p ON p.idx = o.plan_idx
       CROSS JOIN LATERAL (SELECT CASE WHEN p.type = 'TRIAL' THEN 'TRIAL' WHEN l.r < 0.03 THEN 'REVOKED'
                                       WHEN l.r < 0.04 THEN 'SUSPENDED' ELSE 'ACTIVE' END AS status) st
       CROSS JOIN LATERAL (SELECT CASE WHEN p.type = 'ONE_TIME' THEN NULL
                                       WHEN p.type = 'TRIAL' THEN o.created + interval '14 days'
                                       WHEN p.ivl = 'MONTH' THEN now() + (l.r2 * 60 - 30) * interval '1 day'
                                       ELSE now() + (l.r2 * 455 - 90) * interval '1 day' END AS expires) t`,
    ],
    [
      "devices",
      `INSERT INTO "DeviceActivation" (id, "licenseId", fingerprint, name, os, "appVersion", "activatedAt", "lastSeenAt",
              "deactivatedAt", "deactivatedBy")
       SELECT 'dev_' || i, 'LIC-' || (100001 + (i - 1) % ${LIC}), encode(sha256(('perf-fp-' || i)::bytea), 'hex'),
              'Counter ' || i, 'Windows 11', '1.0.0', now() - (30 + random() * 670) * interval '1 day', ${ago(60)},
              CASE WHEN i % 10 = 0 THEN ${ago(300)} END, CASE WHEN i % 10 = 0 THEN 'customer' END
       FROM generate_series(1, ${DEV}) i`,
    ],
    [
      "license events",
      `INSERT INTO "LicenseEvent" (id, "licenseId", type, actor, "createdAt")
       SELECT 'lev_' || i, 'LIC-' || (100001 + (i - 1) % ${LIC}),
              (ARRAY['issued','activated','renewed','key_revealed','deactivated'])[1 + i % 5], 'System', ${ago(1095)}
       FROM generate_series(1, ${n(1_000_000)}) i`,
    ],
    [
      "audit log",
      `INSERT INTO "AuditLog" (id, "actorId", "actorRole", action, target, "targetType", "targetId", "ipPrefix", "createdAt")
       SELECT 'aud_' || i, CASE WHEN i % 4 = 0 THEN NULL ELSE 'stf_' || (1 + i % 12) END,
              CASE WHEN i % 4 = 0 THEN 'system' ELSE (ARRAY['owner','admin','support','finance'])[1 + (1 + i % 12) % 4] END,
              (ARRAY['order.paid','Suspended license','Reinstated license','Refunded order','Updated plan price',
                     'Exported orders CSV','Sent renewal reminder','Replied to ticket','Updated settings','Revoked license'])[1 + i % 10],
              'Target ' || i,
              (ARRAY['order','license','license','order','plan','export','license','ticket','settings','license'])[1 + i % 10],
              'X-' || i, '103.21.44.x', ${ago(1095)}
       FROM generate_series(1, ${n(300_000)}) i`,
    ],
    [
      "account activity",
      `INSERT INTO "AccountActivity" (id, "accountId", "actorName", action, target, kind, "createdAt")
       SELECT 'act_' || i, 'acc_' || CASE WHEN i <= ${n(20_000)} THEN 1 ELSE 1 + (i::bigint * 7919) % ${ACC} END, 'Device',
              (ARRAY['Activated device','Downloaded installer','Paid invoice','Signed in','Invited team member','Opened ticket'])[1 + i % 6],
              'LIC-' || i, (ARRAY['license','download','billing','security','team','ticket'])[1 + i % 6], ${ago(720)}
       FROM generate_series(1, ${n(500_000)}) i`,
    ],
    [
      "tickets",
      `INSERT INTO "SupportTicket" (id, "accountId", subject, priority, status, "assigneeId", "openedById", "firstResponseAt",
              "resolvedAt", "closedAt", "createdAt", "updatedAt")
       SELECT 'T-' || (100000 + i), 'acc_' || a, 'Perf ticket ' || i, (ARRAY['LOW','NORMAL','NORMAL','HIGH'])[1 + i % 4]::"TicketPriority",
              s::"TicketStatus", CASE WHEN i % 10 < 7 THEN 'stf_' || (1 + i % 12) END, 'usr_' || a, c + interval '2 hours',
              CASE WHEN s IN ('RESOLVED','CLOSED') THEN c + interval '2 days' END, CASE WHEN s = 'CLOSED' THEN c + interval '16 days' END,
              c, c + interval '2 days'
       FROM (SELECT i, CASE WHEN i <= 300 THEN 1 ELSE 1 + (i::bigint * 7919) % ${ACC} END AS a, ${ago(1095)} AS c,
                    CASE WHEN i % 20 < 3 THEN 'OPEN' WHEN i % 20 < 5 THEN 'AWAITING_CUSTOMER' WHEN i % 20 < 11 THEN 'RESOLVED'
                         ELSE 'CLOSED' END AS s
             FROM generate_series(1, ${n(30_000)}) i) t`,
    ],
    [
      "ticket messages",
      `INSERT INTO "TicketMessage" (id, "ticketId", "authorId", "isStaff", body, attachments, "createdAt")
       SELECT 'tm_' || t.id || '_' || k, t.id, CASE WHEN k = 2 THEN COALESCE(t."assigneeId", 'stf_2') ELSE t."openedById" END,
              k = 2, 'Perf message', '[]'::jsonb, t."createdAt" + k * interval '1 hour'
       FROM "SupportTicket" t CROSS JOIN generate_series(1, 3) k`,
    ],
    [
      "webhook events",
      `INSERT INTO "WebhookEvent" (provider, id, type, "orderId", result, payload, "receivedAt", "processedAt")
       SELECT 'razorpay', 'evt_perf_o' || o.i, 'payment.captured', 'AX-' || (100000 + o.i), 'fulfilled', '{}'::jsonb,
              o.created + interval '2 minutes', o.created + interval '2 minutes'
       FROM perf_order o WHERE o.status IN ('PAID','REFUNDED','PARTIALLY_REFUNDED')`,
    ],
    [
      "webhook deliveries",
      `INSERT INTO "WebhookDelivery" (id, provider, "eventId", type, "orderId", "signatureOk", result, "receivedAt")
       SELECT 'whd_' || i, 'razorpay', 'evt_perf' || i, 'payment.captured', 'AX-' || (100001 + (i - 1) % ${ORD}), true,
              CASE WHEN i % 2 = 0 THEN 'duplicate_ignored' ELSE 'fulfilled' END, ${ago(1095)}
       FROM generate_series(1, ${n(400_000)}) i`,
    ],
    [
      "downloads",
      `INSERT INTO "DownloadEvent" (id, "fileId", "userId", "licenseId", "createdAt", "expiresAt")
       SELECT 'dl_' || g.i, f.id, 'usr_' || (1 + g.i % ${ACC}), 'LIC-' || (100001 + (g.i - 1) % ${LIC}), g.c, g.c + interval '10 minutes'
       FROM (SELECT i, ${ago(720)} AS c FROM generate_series(1, ${n(100_000)}) i) g
       JOIN (SELECT id, (row_number() OVER (ORDER BY id))::int - 1 AS k, (count(*) OVER ())::int AS cnt FROM "ReleaseFile") f
         ON f.k = g.i % f.cnt`,
    ],
    [
      "notifications",
      `INSERT INTO "Notification" (id, "userId", kind, title, body, "readAt", "createdAt")
       SELECT 'ntf_' || i, 'usr_' || (1 + (i - 1) % ${ACC}), (ARRAY['renewal','update','ticket','billing','security'])[1 + i % 5],
              'Perf notification', 'Body', CASE WHEN i % 10 < 7 THEN now() END, ${ago(365)}
       FROM generate_series(1, ${n(200_000)}) i`,
    ],
    [
      "outbox",
      `INSERT INTO "OutboxEmail" (id, "templateId", "to", subject, html, text, "dedupeKey", status, attempts, "sendAfter",
              "createdAt", "sentAt")
       SELECT 'ob_' || g.i, t.tpl, 'perf-owner-' || (1 + g.i % ${ACC}) || '@example.test', 'Perf subject', '<p>redacted</p>', 'redacted',
              CASE WHEN t.tpl LIKE 'renewal%'
                   THEN 'renewal:LIC-' || (100001 + g.i % ${LIC}) || ':' || t.tpl || ':exp-2026-' || lpad((1 + g.i % 12)::text, 2, '0')
                        || '-15:' || substr(md5(g.i::text), 1, 16)
                   ELSE t.tpl || ':perf-' || g.i END,
              'SENT', 1, g.c, g.c, g.c + interval '5 seconds'
       FROM (SELECT i, ${ago(365)} AS c FROM generate_series(1, ${n(200_000)}) i) g
       CROSS JOIN LATERAL (SELECT (ARRAY['order_confirmation','renewal_30','renewal_7','ticket_reply','license_issued'])[1 + g.i % 5] AS tpl) t`,
    ],
    [
      "leads",
      `INSERT INTO "Lead" (id, kind, status, name, "businessName", email, phone, message, "createdAt", "updatedAt")
       SELECT CASE WHEN i % 2 = 0 THEN 'DEMO-' ELSE 'MSG-' END || (100000 + i),
              (CASE WHEN i % 2 = 0 THEN 'DEMO' ELSE 'CONTACT' END)::"LeadKind",
              (ARRAY['NEW','CONTACTED','SCHEDULED','CLOSED','SPAM'])[1 + i % 5]::"LeadStatus", 'Perf Lead ' || i, 'Perf Biz',
              'perf-lead-' || i || '@example.test', '9000000000', 'Perf message', c, c
       FROM (SELECT i, ${ago(720)} AS c FROM generate_series(1, ${n(20_000)}) i) g`,
    ],
  ];
}

async function create() {
  const admin = await connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
    if (exists.rowCount) throw new Error(`Schema ${schema} already exists; drop it first or pick another --schema.`);
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }
  console.info(`create: schema ${schema} (scale ${SCALE}); applying migrations`);
  try {
    await fill();
  } catch (e) {
    // A half-built schema is useless: drop it so a re-run can use the same name.
    await drop().catch(() => {});
    throw e;
  }
}

/** Migrations, the catalog copy and the synthetic data, in the new scratch schema. */
async function fill() {
  const t0 = performance.now();
  execSync("npx prisma migrate deploy", {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: urlFor(schema), PRISMA_HIDE_UPDATE_MESSAGE: "1" },
    stdio: "pipe",
  });
  const client = await connect(schema);
  try {
    for (const table of CATALOG_TABLES) {
      // Enum columns are typed per schema, so they are cast through text to the scratch schema's own types.
      const cols = await client.query(
        `SELECT column_name, data_type, udt_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, table],
      );
      const select = cols.rows.map(({ column_name: c, data_type: t, udt_name: u }) => {
        if (t === "USER-DEFINED") return `"${c}"::text::"${schema}"."${u}"`;
        if (t === "ARRAY" && !["_text", "_int4"].includes(u)) return `"${c}"::text[]::"${schema}"."${u.slice(1)}"[]`;
        return `"${c}"`;
      });
      const names = cols.rows.map((r) => `"${r.column_name}"`).join(", ");
      const r = await client.query(
        `INSERT INTO "${schema}"."${table}" (${names}) SELECT ${select.join(", ")} FROM "${sourceSchema}"."${table}"`,
      );
      console.info(`  catalog ${table}: ${r.rowCount} rows from ${sourceSchema}`);
    }
    for (const [label, sql] of dataStatements()) {
      const t = performance.now();
      const r = await client.query(sql);
      if (r.rowCount !== null && r.command !== "SELECT") console.info(`  ${label}: ${r.rowCount} rows in ${ms(t)}`);
    }
    const tables = await client.query("SELECT tablename FROM pg_tables WHERE schemaname = $1", [schema]);
    for (const { tablename } of tables.rows) await client.query(`VACUUM (ANALYZE) "${schema}"."${tablename}"`);
    const size = await client.query(
      `SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) AS size FROM pg_class c
       JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE ns.nspname = $1 AND c.relkind = 'r'`,
      [schema],
    );
    console.info(`create: done in ${ms(t0)}, ${size.rows[0].size} on disk. Next: node scripts/perf-db.mjs explain --schema=${schema}`);
  } finally {
    await client.end();
  }
}

async function drop() {
  const admin = await connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    console.info(`drop: schema ${schema} dropped`);
  } finally {
    await admin.end();
  }
}

// ---------- explain ----------

/**
 * Loads app modules through tsx. `server-only` throws outside React Server code, so it is mapped to the package's
 * own empty module with a synchronous resolve hook, which covers both import and the require() calls tsx compiles
 * TypeScript to (the same mapping as vitest.config.mts).
 */
async function appLoader() {
  const serverOnly = createRequire(import.meta.url).resolve("server-only");
  const empty = pathToFileURL(path.join(path.dirname(serverOnly), "empty.js")).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return specifier === "server-only" ? { url: empty, shortCircuit: true } : nextResolve(specifier, context);
    },
  });
  const { tsImport } = await import("tsx/esm/api");
  const tsconfig = path.join(ROOT, "tsconfig.json");
  return (file) => tsImport(pathToFileURL(path.join(ROOT, file)).href, { parentURL: import.meta.url, tsconfig });
}

const BIG_TABLE_ROWS = 10_000;

function planNodes(node) {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

/** One-line summary of an EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) result. */
function summarisePlan(json, tableRows) {
  const root = json[0];
  const flags = [];
  const scans = [];
  for (const node of planNodes(root.Plan)) {
    const rel = node["Relation Name"];
    const loops = node["Actual Loops"] ?? 1;
    const rows = (node["Actual Rows"] ?? 0) * loops;
    if (node["Node Type"] === "Seq Scan" && (tableRows.get(rel) ?? 0) > BIG_TABLE_ROWS) flags.push(`SEQ ${rel}`);
    if (node["Sort Space Type"] === "Disk" || (node["Hash Batches"] ?? 1) > 1 || (node["Disk Usage"] ?? 0) > 0) {
      flags.push(`DISK ${node["Node Type"]}`);
    }
    if ((node["Rows Removed by Filter"] ?? 0) * loops > 50_000) flags.push(`FILTER ${rel ?? node["Node Type"]}`);
    if (rel || node["Index Name"]) scans.push(`${node["Node Type"]} ${node["Index Name"] ?? rel} (${rows})`);
  }
  return {
    ms: root["Execution Time"],
    rows: root.Plan["Actual Rows"],
    hit: root.Plan["Shared Hit Blocks"] ?? 0,
    read: root.Plan["Shared Read Blocks"] ?? 0,
    flags: [...new Set(flags)],
    scans: [...new Set(scans)],
  };
}

/** Statements left out of the report: transaction control and rate-limit bookkeeping. */
const SKIP_SQL = /^\s*(BEGIN|COMMIT|ROLLBACK|SET|DEALLOCATE)\b|"RateLimitBucket"/i;
const oneLine = (sql) => sql.replace(/\s+/g, " ").trim();

/** [area, name, run] for every read path measured. `ctx.m` holds the app modules. */
function scenarioList(ctx) {
  const { m, db, now, big, typical } = ctx;
  const ownerScope = { accountId: big, role: "OWNER" };
  const params = (s) => new URLSearchParams(s);
  const adminUrl = (p) => new URL(`http://perf.local/api/admin/${p}`);
  const listQuery = (p, spec) => m.listState.listQueryFromParsed(m.listQuery.parseListQuery(adminUrl(p), spec));
  const licQuery = (s) => listQuery(`licenses?${s}`, m.licenseModel.LICENSE_LIST_SPEC);
  const custQuery = (s) => listQuery(`customers?${s}`, m.customerModel.CUSTOMER_LIST_SPEC);
  const renQuery = (s) => listQuery(`renewals?${s}`, m.renewalModel.RENEWAL_LIST_SPEC);
  const auditQuery = (s) => m.listQuery.parseListQuery(adminUrl(`audit?${s}`), m.auditModel.AUDIT_LIST_SPEC);
  const orderQuery = (s) => m.adminOrders.orderQueryFromRequest(adminUrl(`orders?${s}`));
  const portalLicenses = (scope, s) => m.account.listAccountLicenses(db, scope, m.licenseActions.parseLicenseListQuery(params(s)), now);
  return [
    // Device API: activation by key hash, validation (steady state and first-of-day presence write).
    ["device", "activate (new device)", () => ctx.activate()],
    ["device", "validate (steady state)", () => ctx.validate()],
    ["device", "validate (first of the day: presence UPDATE)", async () => {
      await ctx.makeStale();
      return ctx.validate();
    }],
    // Customer portal: the large account (4,000 licenses) and a typical one.
    ["portal", "licenses (large account)", () => portalLicenses(ownerScope, "")],
    ["portal", "licenses expiring (large account)", () => portalLicenses(ownerScope, "status=expiring")],
    ["portal", "licenses (typical account)", () => portalLicenses({ accountId: typical, role: "OWNER" }, "")],
    ["portal", "license detail", () => m.account.getAccountLicenseDetail(db, ownerScope, "LIC-100001", now)],
    ["portal", "devices (large account)", () => m.account.listAccountDevices(db, ownerScope, m.licenseActions.parseDeviceListQuery(params("")), now)],
    ["portal", "orders (large account)", () => m.portalOrders.listAccountOrders(db, big, m.portalValidation.parseOrderListQuery(params("")))],
    ["portal", "overview (large account)", () => m.portalOverview.getAccountOverview(db, { accountId: big, legalName: "Perf Business 1", role: "OWNER" }, now)],
    ["portal", "activity (large account)", () => m.portalActivity.listAccountActivity(db, big, m.teamValidation.parseActivityQuery(params("")), now)],
    ["portal", "billing (large account)", () => m.portalBilling.getBilling(big, db)],
    ["portal", "software and downloads (large account)", () => m.software.loadAccountSoftware(db, { accountId: big, role: "OWNER", now })],
    // Admin console: the shell badges every admin page loads, lists with default sort and typical filters, details.
    ["admin", "sidebar badges", () => m.adminContext.loadAdminBadges(db, "OWNER")],
    ["admin", "orders: default", () => m.adminOrders.listAdminOrders(db, orderQuery(""), now)],
    ["admin", "orders: paid, last 30 days", () => m.adminOrders.listAdminOrders(db, orderQuery("filter[status]=paid&filter[date]=30d"), now)],
    ["admin", "orders: search by email", () => m.adminOrders.listAdminOrders(db, orderQuery("q=perf-owner-4242%40example.test"), now)],
    ["admin", "orders: search by id", () => m.adminOrders.listAdminOrders(db, orderQuery("q=AX-104242"), now)],
    ["admin", "orders: stats + filter options", () => Promise.all([m.adminOrders.adminOrderStats(db), m.adminOrders.adminOrderFilterOptions(db)])],
    ["admin", "order detail", () => m.adminOrderDetail.getAdminOrderDetail(db, "AX-100001", now)],
    ["admin", "licenses: default", () => m.adminLicenses.listAdminLicenses(db, licQuery(""), now)],
    ["admin", "licenses: expiring", () => m.adminLicenses.listAdminLicenses(db, licQuery("filter[status]=expiring"), now)],
    ["admin", "licenses: product filter, sort by expiry", () => m.adminLicenses.listAdminLicenses(db, licQuery(`filter[product]=${ctx.productId}&sort=expires`), now)],
    ["admin", "licenses: search", () => m.adminLicenses.listAdminLicenses(db, licQuery("q=perf-owner-4242"), now)],
    ["admin", "licenses: stats", () => m.adminLicenses.adminLicenseStats(db, now)],
    ["admin", "license detail", () => m.adminLicenses.getAdminLicenseDetail(db, "LIC-100001", now)],
    ["admin", "customers: default (lifetime value)", () => m.adminCustomers.listAdminCustomers(db, custQuery(""), now)],
    ["admin", "customers: search", () => m.adminCustomers.listAdminCustomers(db, custQuery("q=Perf%20Business%204242"), now)],
    ["admin", "customers: state filter, sort by last order", () => m.adminCustomers.listAdminCustomers(db, custQuery("filter[state]=Kerala&sort=-lastOrder"), now)],
    ["admin", "customer detail", () => m.adminCustomers.getAdminCustomerDetail(db, big, now)],
    ["admin", "audit: default", () => m.adminAudit.listAudit(db, auditQuery(""))],
    ["admin", "audit: role filter", () => m.adminAudit.listAudit(db, auditQuery("filter[role]=finance"))],
    ["admin", "audit: date range", () => m.adminAudit.listAudit(db, auditQuery("filter[from]=2026-09-01&filter[to]=2026-09-30"))],
    ["admin", "audit: facets + recent actions", () => Promise.all([m.adminAudit.auditFacets(db), m.adminAudit.recentAuditActions(db)])],
    ["admin", "renewals: default", () => m.adminRenewals.listAdminRenewals(db, renQuery(""), now)],
    ["admin", "renewals: stats", () => m.adminRenewals.adminRenewalStats(db, now)],
    ["admin", "overview 30d", () => m.adminOverview.getAdminOverview(db, { range: "30d", now, includeActivity: true })],
    ["admin", "overview 12m", () => m.adminOverview.getAdminOverview(db, { range: "12m", now, includeActivity: true })],
    ["admin", "reports 30d", () => m.adminReports.getAdminReports(db, { range: "30d", now })],
    ["admin", "reports 12m", () => m.adminReports.getAdminReports(db, { range: "12m", now })],
    ["admin", "tickets: default", () => m.adminTickets.listAdminTickets({ query: m.adminTicketModel.parseAdminTicketQuery(adminUrl("tickets")), staffId: "stf_4", now }, db)],
    // Jobs: the renewals cron batch (same Prisma call as sendScheduledRenewalReminders), its outbox dedupe lookup and
    // the release fan-out query (notifyReleaseAvailable), without sending anything.
    ["jobs", "renewals cron: 30-day window batch", () => ctx.renewalBatch(23, 30)],
    ["jobs", "renewals cron: 7-day window batch", () => ctx.renewalBatch(0, 7)],
    ["jobs", "renewals cron: outbox dedupe lookup", () =>
      db.outboxEmail.findFirst({ where: { dedupeKey: { startsWith: "renewal:LIC-100042:renewal_30:exp-2026-11-15:" } }, select: { id: true } })],
    ["jobs", "release fan-out: entitled accounts batch", () => ctx.fanOut()],
  ];
}

const MODULES = {
  activation: "lib/licensing/activation.ts",
  issue: "lib/licensing/issue.ts",
  account: "lib/licensing/account.ts",
  licenseActions: "lib/validation/license-actions.ts",
  portalValidation: "lib/validation/portal.ts",
  teamValidation: "lib/validation/team.ts",
  portalOrders: "lib/portal/orders.ts",
  portalOverview: "lib/portal/overview.ts",
  portalActivity: "lib/portal/activity.ts",
  portalBilling: "lib/portal/billing.ts",
  software: "lib/software/load.ts",
  adminContext: "lib/admin/context.ts",
  listQuery: "lib/admin/list-query.ts",
  listState: "lib/admin/licenses/list-state.ts",
  adminOrders: "lib/admin/orders/list.ts",
  adminOrderDetail: "lib/admin/orders/detail.ts",
  licenseModel: "lib/admin/licenses/model.ts",
  adminLicenses: "lib/admin/licenses/queries.ts",
  customerModel: "lib/admin/customers/model.ts",
  adminCustomers: "lib/admin/customers/queries.ts",
  auditModel: "lib/admin/audit/model.ts",
  adminAudit: "lib/admin/audit/service.ts",
  renewalModel: "lib/admin/renewals/model.ts",
  adminRenewals: "lib/admin/renewals/queries.ts",
  adminOverview: "lib/admin/overview/service.ts",
  adminReports: "lib/admin/reports/service.ts",
  adminTickets: "lib/admin/tickets/service.ts",
  adminTicketModel: "lib/admin/tickets/model.ts",
  db: "lib/db.ts",
  capture: "tests/support/query-capture.ts",
};

/** EXPLAIN of one captured statement in its own rolled-back transaction. INSERTs are planned, not executed again. */
async function explainOne(pgc, q, tableRows) {
  const analyze = !/^\s*INSERT\b/i.test(q.sql);
  const options = analyze ? "ANALYZE, BUFFERS" : "COSTS";
  const run = async (format) => {
    await pgc.query("BEGIN");
    try {
      return (await pgc.query(`EXPLAIN (${options}${format}) ${q.sql}`, q.params)).rows;
    } finally {
      await pgc.query("ROLLBACK");
    }
  };
  const json = (await run(", FORMAT JSON"))[0]["QUERY PLAN"];
  const summary = analyze ? summarisePlan(json, tableRows) : { ms: 0, rows: 0, hit: 0, read: 0, flags: ["PLAN ONLY (insert)"], scans: [] };
  const text = opt.plans === "true" || opt.out ? (await run("")).map((row) => row["QUERY PLAN"]).join("\n") : null;
  return { ...summary, text };
}

async function explain() {
  const url = urlFor(schema);
  process.env.DATABASE_URL = url; // lib/db's default client points at the scratch schema too
  const load = await appLoader();
  const m = {};
  for (const [key, file] of Object.entries(MODULES)) m[key] = await load(file);
  const { client: db, queries } = m.capture.capturingClient(url);
  m.db.setDbClient(db);
  const pgc = await connect(schema);
  // Parallel query is off unless --parallel: on Windows each parallel worker is a new process (hundreds of ms to start),
  // which would hide the real cost. --settings="random_page_cost=1.1,work_mem=16MB" tries planner settings.
  if (opt.parallel !== "true") await pgc.query("SET max_parallel_workers_per_gather = 0");
  for (const setting of (opt.settings ?? "").split(",").filter(Boolean)) {
    const [name, value] = setting.split("=");
    if (!/^[a-z_]+$/.test(name ?? "") || !/^[A-Za-z0-9.]+$/.test(value ?? "")) throw new Error(`Bad --settings entry: ${setting}`);
    await pgc.query(`SET ${name} = '${value}'`);
  }
  const counts = await pgc.query(
    `SELECT c.relname, c.reltuples::bigint AS n FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = $1 AND c.relkind = 'r'`,
    [schema],
  );
  const tableRows = new Map(counts.rows.map((r) => [r.relname, Number(r.n)]));
  const now = new Date();

  // Device API fixture: one real license with a known key in the large account, issued by the app's issueLicense().
  const plan = await db.plan.findFirst({ where: { type: "ANNUAL", archived: false }, include: { product: true }, orderBy: { id: "asc" } });
  if (!plan) throw new Error("No annual plan in the scratch schema (catalog copy missing?).");
  const { license, key } = await db.$transaction((tx) =>
    m.issue.issueLicense(tx, {
      accountId: "acc_1",
      product: { id: plan.productId, code: plan.product.code },
      plan,
      qty: 1,
      at: now,
      actor: "System",
      eventDetail: "perf-db fixture",
    }),
  );
  const release = await db.release.findFirst({ where: { productId: plan.productId, status: "PUBLISHED" }, orderBy: { releasedAt: "desc" } });
  const fingerprint = randomBytes(32).toString("hex");
  const deviceCtx = { appId: plan.product.code, ip: "198.18.0.10", db };
  let token = null;
  const day = 86_400_000;
  const ctx = {
    m,
    db,
    now,
    big: "acc_1",
    typical: "acc_4242",
    productId: plan.productId,
    activate: async () => {
      const input = { licenseKey: key, deviceFingerprint: fingerprint, deviceName: "Perf device", os: "Windows 11", appVersion: "1.0.0" };
      token = (await m.activation.activateLicense(input, deviceCtx)).activationToken;
    },
    validate: () => m.activation.validateActivation({ activationToken: token, deviceFingerprint: fingerprint, appVersion: "1.0.0" }, deviceCtx),
    makeStale: () => pgc.query(`UPDATE "DeviceActivation" SET "lastSeenAt" = now() - interval '13 hours' WHERE "licenseId" = $1`, [license.id]),
    renewalBatch: (fromDays, toDays) =>
      db.license.findMany({
        where: {
          status: "ACTIVE",
          plan: { type: { not: "TRIAL" } },
          expiresAt: { gt: new Date(now.getTime() + fromDays * day), lte: new Date(now.getTime() + toDays * day) },
        },
        orderBy: { id: "asc" },
        take: 200,
        select: { id: true, accountId: true, orderId: true, expiresAt: true, product: { select: { name: true } } },
      }),
    fanOut: () => db.$queryRaw`
      SELECT DISTINCT "accountId" FROM "License"
      WHERE "productId" = ${plan.productId} AND "accountId" IS NOT NULL AND "accountId" > ${""}
        AND "status" IN ('ACTIVE'::"LicenseStatus", 'TRIAL'::"LicenseStatus")
        AND ("expiresAt" IS NULL OR "expiresAt" > ${now}::timestamp(3))
        AND "updatesUntil" >= ${release?.releasedAt ?? now}::timestamp(3)
      ORDER BY "accountId" LIMIT ${500}::int`,
  };

  const only = opt.only ? new Set(opt.only.split(",")) : null;
  const outDir = opt.out ? path.resolve(opt.out) : null;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const all = [];
  console.info(`explain: schema ${schema}; per statement: Postgres execution ms, rows, shared buffers hit/read, scans`);
  try {
    for (const [area, name, run] of scenarioList(ctx)) {
      if (only && !only.has(area)) continue;
      queries.length = 0;
      const t = performance.now();
      try {
        await run();
      } catch (e) {
        console.info(`\n[${area}] ${name}: FAILED (${e?.message ?? e})`);
        continue;
      }
      const wallMs = performance.now() - t;
      const statements = queries.filter((q) => !SKIP_SQL.test(q.sql));
      const results = [];
      for (const q of statements) {
        try {
          results.push({ q, ...(await explainOne(pgc, q, tableRows)) });
        } catch (e) {
          results.push({ q, ms: 0, rows: 0, hit: 0, read: 0, flags: [`EXPLAIN FAILED: ${e?.message ?? e}`], scans: [], text: null });
        }
      }
      const dbMs = results.reduce((s, r) => s + r.ms, 0);
      console.info(`\n[${area}] ${name}: ${results.length} statements, ${dbMs.toFixed(1)} ms in Postgres (wall ${wallMs.toFixed(0)} ms)`);
      for (const r of results) {
        const flags = r.flags.length ? `  << ${r.flags.join(", ")}` : "";
        console.info(`  ${r.ms.toFixed(2).padStart(8)} ms  rows ${String(r.rows).padStart(5)}  buf ${r.hit}/${r.read}  ${r.scans.join("; ")}${flags}`);
        console.info(`             ${oneLine(r.q.sql).slice(0, 150)}`);
        if (opt.plans === "true" && r.text) console.info(r.text.replace(/^/gm, "             | "));
        all.push({ area, name, ...r });
      }
      if (outDir) {
        const file = path.join(outDir, `${area}-${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.txt`);
        fs.writeFileSync(file, results.map((r) => `${oneLine(r.q.sql)}\n\n${r.text ?? ""}\n`).join("\n----\n\n"));
      }
    }
  } finally {
    await pgc.end();
    await db.$disconnect();
  }
  const slow = all.filter((r) => r.ms >= 20 || r.flags.some((f) => !f.startsWith("PLAN ONLY"))).sort((a, b) => b.ms - a.ms);
  console.info(`\nSummary: ${all.length} statements; ${slow.length} at or over 20 ms or flagged:`);
  for (const r of slow) console.info(`  ${r.ms.toFixed(1).padStart(8)} ms  [${r.area}] ${r.name}  ${r.flags.join(", ")}`);
}

// ---------- indexes ----------

/**
 * Index proposals measured with this script (docs/performance.md "Database at scale"); `indexes` applies them to the
 * scratch schema (and `--undo` drops them). The production migration is the same SQL with CREATE EXTENSION pg_trgm.
 */
const PROPOSED_INDEXES = [
  // Admin Orders default list (newest first) and the overview/report revenue windows (paidAt).
  { name: "Order_createdAt_idx", table: "Order", sql: `CREATE INDEX IF NOT EXISTS "Order_createdAt_idx" ON "Order" ("createdAt")` },
  { name: "Order_paidAt_idx", table: "Order", sql: `CREATE INDEX IF NOT EXISTS "Order_paidAt_idx" ON "Order" ("paidAt")` },
  // Reports: sales and GST by invoice month.
  { name: "Invoice_issuedAt_idx", table: "Invoice", sql: `CREATE INDEX IF NOT EXISTS "Invoice_issuedAt_idx" ON "Invoice" ("issuedAt")` },
  // Admin Licenses default sort (issued, newest first) and the "last 4 of the key" search.
  { name: "License_issuedAt_idx", table: "License", sql: `CREATE INDEX IF NOT EXISTS "License_issuedAt_idx" ON "License" ("issuedAt")` },
  { name: "License_keyLast4_idx", table: "License", sql: `CREATE INDEX IF NOT EXISTS "License_keyLast4_idx" ON "License" ("keyLast4")` },
  // License health counts by status, end date and product as index-only scans (replaces License_status_expiresAt_idx).
  {
    name: "License_status_expiresAt_productId_idx",
    table: "License",
    sql: `CREATE INDEX IF NOT EXISTS "License_status_expiresAt_productId_idx" ON "License" ("status", "expiresAt", "productId")`,
  },
  // Staff lookups (workload, audit facets) among customer users.
  { name: "User_kind_idx", table: "User", sql: `CREATE INDEX IF NOT EXISTS "User_kind_idx" ON "User" ("kind")` },
  // Trigram indexes for the contains-searches (admin license, order and customer search); need pg_trgm.
  { name: "License_id_trgm_idx", table: "License", sql: `CREATE INDEX IF NOT EXISTS "License_id_trgm_idx" ON "License" USING GIN ("id" gin_trgm_ops)` },
  { name: "Order_email_trgm_idx", table: "Order", sql: `CREATE INDEX IF NOT EXISTS "Order_email_trgm_idx" ON "Order" USING GIN ("email" gin_trgm_ops)` },
  { name: "User_email_trgm_idx", table: "User", sql: `CREATE INDEX IF NOT EXISTS "User_email_trgm_idx" ON "User" USING GIN ("email" gin_trgm_ops)` },
  { name: "User_name_trgm_idx", table: "User", sql: `CREATE INDEX IF NOT EXISTS "User_name_trgm_idx" ON "User" USING GIN ("name" gin_trgm_ops)` },
  {
    name: "BusinessAccount_legalName_trgm_idx",
    table: "BusinessAccount",
    sql: `CREATE INDEX IF NOT EXISTS "BusinessAccount_legalName_trgm_idx" ON "BusinessAccount" USING GIN ("legalName" gin_trgm_ops)`,
  },
  {
    name: "DeviceActivation_name_trgm_idx",
    table: "DeviceActivation",
    sql: `CREATE INDEX IF NOT EXISTS "DeviceActivation_name_trgm_idx" ON "DeviceActivation" USING GIN ("name" gin_trgm_ops)`,
  },
];

async function indexes() {
  const client = await connect(schema);
  try {
    if (opt.undo !== "true") await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA "${schema}"`);
    for (const { name, sql } of PROPOSED_INDEXES) {
      const t = performance.now();
      if (opt.undo === "true") await client.query(`DROP INDEX IF EXISTS "${schema}"."${name}"`);
      else await client.query(sql);
      console.info(`  ${opt.undo === "true" ? "dropped" : "created"} ${name} in ${ms(t)}`);
    }
    if (opt.undo !== "true") {
      const tables = [...new Set(PROPOSED_INDEXES.map((i) => i.table))];
      for (const table of tables) await client.query(`ANALYZE "${schema}"."${table}"`);
    }
  } finally {
    await client.end();
  }
}

const COMMANDS = { create, explain, indexes, drop };
COMMANDS[command]().catch((e) => {
  console.error(`perf-db ${command} failed: ${e?.message ?? e}`);
  process.exitCode = 1;
});
