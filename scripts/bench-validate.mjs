/**
 * Throughput benchmark of the device API hot path, POST /api/v1/licenses/validate (dev tool; docs/performance.md).
 *
 *   node scripts/bench-validate.mjs [--base=http://localhost:3000[,http://localhost:3001...]] [--concurrency=20]
 *     [--duration=10] [--warmup=0] [--licenses=1] [--activate-concurrency=1] [--spoof-ip] [--product=MED] [--keep]
 *     [--stale] [--json]
 *
 * Setup: issues `--licenses` throwaway licenses straight into DATABASE_URL (.env.local) with the app's own
 * issueLicense() (loaded through tsx; accountId null, so they belong to nobody and show in no portal), then activates
 * one device per license through the real POST /activate. Run: `--concurrency` workers send /validate for
 * `--duration` seconds, round-robin over the devices, and the script prints req/s, latency percentiles and status
 * counts. Cleanup deletes the throwaway licenses with their devices and events (`--keep` leaves them).
 * `--stale` (local licenses only) moves every bench device's lastSeenAt 13 hours back after activation, so the
 * first validation of each device takes the presence-write path (the UPDATE a device makes at its first start of the
 * day, docs/scaling.md "Expected load"); those first-pass requests are reported separately. Use at least as many
 * --licenses as requests to measure a morning storm where every request writes.
 * --warmup sends validations for that many seconds before the measured run (a production server's JIT needs a few
 * seconds); they count toward the per-license limit. Activation is measured too: --activate-concurrency workers send
 * the setup's POST /activate calls (an activation burst: row lock, device insert, LicenseEvent) and the script prints
 * their rate and latency. Several comma-separated --base URLs are used round robin per request, like Nginx in front of
 * several PM2 processes. --json adds one machine-readable line with the results.
 * Remote targets (Phase 7): set BENCH_LICENSE_KEYS to comma-separated keys of licenses on that server instead; the
 * script then activates devices on them and deactivates those devices afterwards.
 *
 * Rate limits shape the result: /validate allows 60/min per client IP and 30/min per license, /activate 60/min per
 * IP. Against a server with TRUSTED_PROXY_HOPS=0 (the dev default) every request shares the "unknown" IP bucket,
 * so a longer run mostly measures the 429 path. To measure the full 200 path, run a server with
 * TRUSTED_PROXY_HOPS=1 (e.g. your own `next dev -p 31xx`), pass --spoof-ip (a random X-Forwarded-For from the
 * RFC 2544 benchmark range 198.18.0.0/15 per request) and enough --licenses:
 * rate x min(warmup + duration, 60) / 30.
 * Never point --spoof-ip runs at the shared dev server. Never prints keys, tokens or fingerprints.
 */
import { randomBytes, randomInt } from "node:crypto";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import nextEnv from "@next/env";

const opt = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);

function intOption(name, fallback, min, max) {
  const raw = opt[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`--${name} must be a whole number from ${min} to ${max}`);
    process.exit(2);
  }
  return n;
}

const BASES = (opt.base ?? process.env.BENCH_BASE_URL ?? "http://localhost:3000").split(",").map((b) => new URL(b.trim()).origin);
const BASE = BASES.join(",");
const CONCURRENCY = intOption("concurrency", 20, 1, 1000);
const DURATION_S = intOption("duration", 10, 1, 600);
const SPOOF_IP = opt["spoof-ip"] === "true";
const KEEP = opt.keep === "true";
const STALE = opt.stale === "true";
const REMOTE_KEYS = (process.env.BENCH_LICENSE_KEYS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
const LICENSES = REMOTE_KEYS.length > 0 ? REMOTE_KEYS.length : intOption("licenses", 1, 1, 20000);
const WARMUP_S = intOption("warmup", 0, 0, 120);
const ACTIVATE_CONCURRENCY = intOption("activate-concurrency", 1, 1, 256);
const JSON_OUT = opt.json === "true";
const APP_VERSION = "1.0.0";
let nextBase = 0;
/** The device API of the next --base, round robin. */
function api() {
  const base = BASES[nextBase % BASES.length];
  nextBase += 1;
  return `${base}/api/v1/licenses`;
}

if (STALE && REMOTE_KEYS.length > 0) {
  console.error("--stale needs local licenses (it updates lastSeenAt in DATABASE_URL); unset BENCH_LICENSE_KEYS.");
  process.exit(2);
}

if (!SPOOF_IP && LICENSES > 50) {
  console.error("More than 50 activations from one IP hit the 60/min activation limit: add --spoof-ip (see the header).");
  process.exit(2);
}

/** A random address in 198.18.0.0/15 (reserved for benchmarks), so per-IP buckets do not collide. */
function benchIp() {
  return `198.${18 + randomInt(2)}.${randomInt(256)}.${1 + randomInt(254)}`;
}

function headers(appId) {
  const h = { "content-type": "application/json", "x-app-id": appId };
  if (SPOOF_IP) h["x-forwarded-for"] = benchIp();
  return h;
}

async function post(endpoint, appId, body) {
  const res = await fetch(`${api()}/${endpoint}`, { method: "POST", headers: headers(appId), body: JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fmt = (n, digits = 1) => (Number.isFinite(n) ? n.toFixed(digits) : "-");

// ---------- setup ----------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let prisma = null;
const issuedIds = [];

/** Issues `count` throwaway licenses with the app's issueLicense(). Returns [{ key, appId }] (keys stay in memory). */
async function issueLocal(count) {
  nextEnv.loadEnvConfig(ROOT, true, { info: () => {}, error: (...args) => console.error(...args) });
  const { tsImport } = await import("tsx/esm/api");
  const load = (file) =>
    tsImport(pathToFileURL(path.join(ROOT, file)).href, { parentURL: import.meta.url, tsconfig: path.join(ROOT, "tsconfig.json") });
  const [{ createPrismaClient }, { issueLicense }] = await Promise.all([load("lib/db.ts"), load("lib/licensing/issue.ts")]);
  prisma = createPrismaClient(process.env.DATABASE_URL);

  const products = await prisma.product.findMany({
    where: { status: "PUBLISHED", ...(opt.product ? { code: opt.product.toUpperCase() } : {}) },
    orderBy: { rank: "asc" },
    include: { plans: { where: { archived: false, type: { in: ["ANNUAL", "ONE_TIME"] }, deviceLimit: { gte: 1 } } } },
  });
  const product = products.find((p) => p.plans.length > 0);
  if (!product) throw new Error(`No published product${opt.product ? ` with code ${opt.product}` : ""} has an annual or one-time plan.`);
  const plan = product.plans.find((p) => p.type === "ANNUAL") ?? product.plans[0];

  const licenses = new Array(count);
  let next = 0;
  async function issueWorker() {
    while (next < count) {
      const i = next;
      next += 1;
      const { license, key } = await prisma.$transaction((tx) =>
        issueLicense(tx, {
          accountId: null,
          product: { id: product.id, code: product.code },
          plan,
          qty: 1,
          at: new Date(),
          actor: "System",
          eventDetail: "bench-validate throwaway license",
        }),
      );
      issuedIds.push(license.id);
      licenses[i] = { key, appId: product.code };
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, count) }, issueWorker));
  return { licenses, label: `product ${product.code}, plan ${plan.id}` };
}

/**
 * One device per license through POST /activate, --activate-concurrency at a time. Returns the devices
 * [{ appId, fingerprint, token }], the status counts and the latency of every activation.
 */
async function activateAll(licenses) {
  const devices = [];
  const statuses = {};
  const latencies = [];
  let refused = 0;
  let next = 0;
  const startedAt = performance.now();
  async function worker() {
    while (next < licenses.length) {
      const i = next;
      next += 1;
      const { key, appId } = licenses[i];
      const fingerprint = randomBytes(32).toString("hex");
      const t = performance.now();
      const res = await post("activate", appId, {
        licenseKey: key,
        deviceFingerprint: fingerprint,
        deviceName: `Bench device ${i + 1}`,
        os: "Benchmark",
        appVersion: APP_VERSION,
      });
      latencies.push(performance.now() - t);
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
      if (res.status === 200 && typeof res.data?.activationToken === "string") {
        devices.push({ appId, fingerprint, token: res.data.activationToken });
      } else {
        refused += 1;
        if (refused === 1) console.error(`activate answered ${res.status} ${res.data?.error?.code ?? ""}`.trim());
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(ACTIVATE_CONCURRENCY, licenses.length) }, worker));
  return { devices, statuses, latencies, elapsedS: (performance.now() - startedAt) / 1000 };
}

/** Moves lastSeenAt of the bench devices 13 h back: their next /validate writes lastSeenAt/appVersion once. */
async function makeStale() {
  if (!prisma || issuedIds.length === 0) return 0;
  const { count } = await prisma.deviceActivation.updateMany({
    where: { licenseId: { in: issuedIds }, deactivatedAt: null },
    data: { lastSeenAt: new Date(Date.now() - 13 * 3600_000) },
  });
  return count;
}

async function cleanup(devices) {
  if (REMOTE_KEYS.length > 0) {
    let freed = 0;
    for (const d of devices) {
      const res = await post("deactivate", d.appId, { activationToken: d.token, deviceFingerprint: d.fingerprint }).catch(() => null);
      if (res?.status === 200) freed += 1;
    }
    console.info(`cleanup: deactivated ${freed}/${devices.length} bench devices`);
    return;
  }
  if (!prisma) return;
  if (KEEP || issuedIds.length === 0) {
    if (issuedIds.length) console.info(`cleanup: kept ${issuedIds.length} throwaway licenses (--keep)`);
  } else {
    const where = { licenseId: { in: issuedIds } };
    const [devicesDeleted, eventsDeleted, licensesDeleted] = await prisma.$transaction([
      prisma.deviceActivation.deleteMany({ where }),
      prisma.licenseEvent.deleteMany({ where }),
      prisma.license.deleteMany({ where: { id: { in: issuedIds }, accountId: null, orderId: null } }),
    ]);
    console.info(
      `cleanup: deleted ${licensesDeleted.count} throwaway licenses, ${devicesDeleted.count} devices, ${eventsDeleted.count} events`,
    );
  }
  await prisma.$disconnect();
}

// ---------- run ----------

function percentile(sorted, q) {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

async function validateOnce(device) {
  const started = performance.now();
  try {
    const res = await post("validate", device.appId, {
      activationToken: device.token,
      deviceFingerprint: device.fingerprint,
      appVersion: APP_VERSION,
    });
    return { ms: performance.now() - started, status: res.status, valid: res.data?.valid === true, code: res.data?.error?.code };
  } catch (e) {
    return { ms: performance.now() - started, status: 0, valid: false, code: e?.cause?.code ?? e?.name ?? "fetch_failed" };
  }
}

async function run(devices, seconds) {
  const latencies = [];
  const firstPass = [];
  const statuses = {};
  const codes = {};
  let valid = 0;
  let next = 0;
  const startedAt = performance.now();
  const deadline = startedAt + seconds * 1000;
  async function worker() {
    while (performance.now() < deadline) {
      const device = devices[next % devices.length];
      const first = next < devices.length;
      next += 1;
      const r = await validateOnce(device);
      latencies.push(r.ms);
      if (first) firstPass.push(r.ms);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      if (r.valid) valid += 1;
      else if (r.code) codes[r.code] = (codes[r.code] ?? 0) + 1;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedS = (performance.now() - startedAt) / 1000;
  return { latencies, firstPass, statuses, codes, valid, elapsedS };
}

/** Prints the run and returns its summary numbers. */
function report(r) {
  const sorted = Float64Array.from(r.latencies).sort();
  const total = sorted.length;
  const mean = total ? r.latencies.reduce((a, b) => a + b, 0) / total : Number.NaN;
  console.info(`result: ${total} requests in ${fmt(r.elapsedS, 2)} s = ${fmt(total / r.elapsedS)} req/s`);
  console.info(
    `latency ms: p50 ${fmt(percentile(sorted, 0.5))}  p95 ${fmt(percentile(sorted, 0.95))}  ` +
      `p99 ${fmt(percentile(sorted, 0.99))}  max ${fmt(sorted[total - 1])}  mean ${fmt(mean)}`,
  );
  const statusLine = Object.entries(r.statuses).map(([s, n]) => `${s === "0" ? "network-error" : s}=${n}`).join("  ");
  console.info(`status: ${statusLine}  (valid:true ${r.valid})`);
  if (STALE) {
    const first = Float64Array.from(r.firstPass).sort();
    console.info(
      `first pass (presence write, ${first.length} requests): p50 ${fmt(percentile(first, 0.5))}  ` +
        `p95 ${fmt(percentile(first, 0.95))}  p99 ${fmt(percentile(first, 0.99))} ms`,
    );
  }
  const codeLine = Object.entries(r.codes).map(([c, n]) => `${c}=${n}`).join("  ");
  if (codeLine) console.info(`error codes: ${codeLine}`);
  const limited = r.statuses[429] ?? 0;
  if (total > 0 && limited / total > 0.05) {
    console.info(
      `note: ${fmt((100 * limited) / total)}% were rate limited (429). For the full 200 path use a server with ` +
        "TRUSTED_PROXY_HOPS=1, --spoof-ip and more --licenses (rate x min(warmup + duration, 60) / 30).",
    );
  }
  return {
    requests: total,
    reqPerS: Number((total / r.elapsedS).toFixed(1)),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    statuses: r.statuses,
  };
}

/** Rate and latency of the setup activations (the activation burst). */
function activationSummary(a) {
  const sorted = Float64Array.from(a.latencies).sort();
  const statusLine = Object.entries(a.statuses).map(([s, n]) => `${s}=${n}`).join(" ");
  console.info(
    `activation: ${sorted.length} requests at concurrency ${Math.min(ACTIVATE_CONCURRENCY, sorted.length)} in ${fmt(a.elapsedS, 2)} s = ` +
      `${fmt(sorted.length / a.elapsedS)} req/s; latency ms p50 ${fmt(percentile(sorted, 0.5))}  p95 ${fmt(percentile(sorted, 0.95))}  ` +
      `p99 ${fmt(percentile(sorted, 0.99))} [${statusLine}]`,
  );
  return { requests: sorted.length, reqPerS: Number((sorted.length / a.elapsedS).toFixed(1)), p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), p99: percentile(sorted, 0.99), statuses: a.statuses };
}

async function main() {
  console.info(
    `bench-validate: base=${BASE} concurrency=${CONCURRENCY} duration=${DURATION_S}s licenses=${LICENSES} ` +
      `warmup=${WARMUP_S}s spoof-ip=${SPOOF_IP ? "yes" : "no"} stale=${STALE ? "yes" : "no"}`,
  );
  const setupStarted = performance.now();
  let devices = [];
  try {
    const { licenses, label } = REMOTE_KEYS.length
      ? { licenses: REMOTE_KEYS.map((key) => ({ key, appId: (opt.product ?? key.slice(0, 3)).toUpperCase() })), label: "BENCH_LICENSE_KEYS" }
      : await issueLocal(LICENSES);
    const activation = await activateAll(licenses);
    devices = activation.devices;
    const statusLine = Object.entries(activation.statuses).map(([s, n]) => `${s}=${n}`).join(" ");
    console.info(
      `setup: ${licenses.length} licenses (${label}), ${devices.length} devices activated [${statusLine}] in ` +
        `${fmt((performance.now() - setupStarted) / 1000, 2)} s`,
    );
    const activated = activationSummary(activation);
    if (devices.length === 0) throw new Error("No device could be activated; nothing to benchmark.");

    const warm = await validateOnce(devices[0]);
    console.info(`warm-up: 1 request, ${warm.status} in ${fmt(warm.ms)} ms (dev servers compile the route on first use)`);
    if (WARMUP_S > 0) {
      const w = await run(devices, WARMUP_S);
      console.info(`warm-up: ${w.latencies.length} requests in ${fmt(w.elapsedS, 1)} s (not measured)`);
    }
    if (STALE) console.info(`stale: ${await makeStale()} devices last seen 13 h ago (first validation of each writes)`);
    await sleep(200);
    const result = report(await run(devices, DURATION_S));
    if (JSON_OUT) {
      const summary = { base: BASE, concurrency: CONCURRENCY, durationS: DURATION_S, warmupS: WARMUP_S, licenses: LICENSES, activation: activated, validate: result };
      console.info(`json: ${JSON.stringify(summary)}`);
    }
  } finally {
    await cleanup(devices).catch((e) => console.error(`cleanup failed: ${e?.message ?? e}`));
  }
}

main().catch((e) => {
  console.error(`bench-validate failed: ${e?.message ?? e}`);
  process.exitCode = 1;
});
