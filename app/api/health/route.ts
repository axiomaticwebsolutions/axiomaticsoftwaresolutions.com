/**
 * GET /api/health (HEAD too, which Next.js answers from GET): readiness for deploy/deploy.sh,
 * rollback.sh and restart.sh (on 127.0.0.1 after every PM2 start or reload) and uptime monitors (deploy/README.md).
 *
 * 200 { status: "ok" } when PostgreSQL answers `SELECT 1` and, when REDIS_URL is set, Redis answers PING, each within
 * 2 s (checked in parallel). Otherwise 503 { status: "unavailable" } with Retry-After. The body never says which
 * dependency failed or why; the failing check names are logged instead, at most once a minute per process.
 * Always `Cache-Control: no-store`.
 *
 * No session, CSRF token or rate limit: it reads nothing about the visitor, writes nothing and costs one trivial query
 * (GET routes skip CSRF; the middleware never matches /api/health; nothing here touches the rate-limit store).
 */
import { Redis } from "ioredis";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { json, route } from "@/lib/http";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHECK_TIMEOUT_MS = 2_000;
const RETRY_AFTER_SEC = 5;
const FAILURE_LOG_INTERVAL_MS = 60_000;

type CheckName = "config" | "database" | "redis";

/** True when `work` settles successfully within CHECK_TIMEOUT_MS. Never rejects; a late failure is swallowed. */
async function within(work: () => Promise<unknown>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), CHECK_TIMEOUT_MS);
  });
  const attempt = Promise.resolve()
    .then(work)
    .then(
      () => true,
      () => false,
    );
  try {
    return await Promise.race([attempt, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

const REDIS_SLOT = Symbol.for("axs.healthRedis");
type RedisSlot = { [REDIS_SLOT]?: { url: string; client: Redis } };

/**
 * One small Redis client per process for PING, kept between checks (the rate-limit store's own connection is private
 * to lib/auth/rate-limit-redis.ts). Connects on first use; bounded by the same 2 s; never logs connection errors itself.
 */
function healthRedis(url: string): Redis {
  const slot = globalThis as RedisSlot;
  const current = slot[REDIS_SLOT];
  if (current?.url === url) return current.client;
  current?.client.disconnect();
  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: CHECK_TIMEOUT_MS,
    commandTimeout: CHECK_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    retryStrategy: (times: number) => Math.min(times * 500, 5_000),
  });
  // Without a listener ioredis prints every connection error; a failed PING is reported by the check instead.
  client.on("error", () => undefined);
  slot[REDIS_SLOT] = { url, client };
  return client;
}

const failureLog = { lastAt: Number.NEGATIVE_INFINITY, suppressed: 0 };

function logFailure(failed: CheckName[]): void {
  const now = Date.now();
  if (now - failureLog.lastAt < FAILURE_LOG_INTERVAL_MS) {
    failureLog.suppressed += 1;
    return;
  }
  log.warn("health_check_failed", { failed, suppressedSinceLast: failureLog.suppressed });
  failureLog.lastAt = now;
  failureLog.suppressed = 0;
}

export const GET = route(async () => {
  let redisUrl: string | undefined;
  let configOk = true;
  try {
    redisUrl = getEnv().REDIS_URL;
  } catch {
    // Production refuses to start with an invalid environment (instrumentation.ts); development reports it here.
    configOk = false;
  }

  const [databaseOk, redisOk] = await Promise.all([
    within(() => db.$queryRaw`SELECT 1`),
    redisUrl ? within(() => healthRedis(redisUrl).ping()) : Promise.resolve(true),
  ]);

  const failed: CheckName[] = [];
  if (!configOk) failed.push("config");
  if (!databaseOk) failed.push("database");
  if (!redisOk) failed.push("redis");
  if (failed.length === 0) return json({ status: "ok" }, { headers: { "cache-control": "no-store" } });

  logFailure(failed);
  return json(
    { status: "unavailable" },
    { status: 503, headers: { "cache-control": "no-store", "retry-after": String(RETRY_AFTER_SEC) } },
  );
});
