/**
 * RedisRateLimitStore against a real Redis: REDIS_URL, else redis://127.0.0.1:6379 (Memurai in development).
 * When no Redis answers, the live tests are skipped with a visible note; the failure-policy tests (a store pointed at
 * a closed port) always run. Every key lives under a per-run prefix and only those keys are deleted afterwards.
 */
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  RATE_LIMITS,
  attempt,
  clear,
  enforceAttempts,
  hit,
  peek,
  refund,
  setRateLimitStore,
  type RateLimitRule,
} from "@/lib/auth/rate-limit";
import {
  REDIS_RATE_LIMIT_PREFIX,
  RedisRateLimitStore,
  installRedisRateLimitStore,
  uninstallRedisRateLimitStore,
} from "@/lib/auth/rate-limit-redis";
import type { Db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { setLogSink } from "@/lib/log";
import { memoryRateLimitStore } from "../support/memory-rate-limit-store";

const REDIS_URL = process.env.REDIS_URL?.trim() || "redis://127.0.0.1:6379";
/** host:port only, never credentials. */
const TARGET = (() => {
  try {
    const u = new URL(REDIS_URL);
    return `${u.hostname}:${u.port || "6379"}`;
  } catch {
    return "(unparseable REDIS_URL)";
  }
})();
const PREFIX = `${REDIS_RATE_LIMIT_PREFIX}test:${randomBytes(6).toString("hex")}:`;
// Every call goes through the registered store, so the Db handle is never touched.
const db = undefined as unknown as Db;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function redisReachable(url: string): Promise<boolean> {
  const probe = new Redis(url, { lazyConnect: true, connectTimeout: 1500, maxRetriesPerRequest: 0, retryStrategy: () => null });
  probe.on("error", () => undefined);
  try {
    await probe.connect();
    return (await probe.ping()) === "PONG";
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const reachable = await redisReachable(REDIS_URL);
if (!reachable) {
  console.warn(
    `[rate-limit-redis] NOTE: no Redis at ${TARGET}; the live RedisRateLimitStore tests are SKIPPED. ` +
      "Start Redis/Memurai on 127.0.0.1:6379 or set REDIS_URL to run them.",
  );
}

let seq = 0;
const uniqueKey = (name: string) => `${name}:${(seq += 1)}`;
const rule = (name: string, limit: number, windowSec: number): RateLimitRule => ({ key: uniqueKey(name), limit, windowSec });

/** A local port with nothing listening (so connections are refused or time out). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("no port");
  return address.port;
}

afterEach(() => {
  setRateLimitStore(null);
});

describe.skipIf(!reachable)(`RedisRateLimitStore against ${TARGET}${reachable ? "" : " (SKIPPED: Redis not reachable)"}`, () => {
  let store: RedisRateLimitStore;
  let raw: Redis;

  beforeAll(async () => {
    store = new RedisRateLimitStore(REDIS_URL, { prefix: PREFIX });
    raw = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await raw.connect();
  });

  afterAll(async () => {
    // Delete only this run's keys (never FLUSHDB: the server is shared).
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await raw.scan(cursor, "MATCH", `${PREFIX}*`, "COUNT", 500);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    if (keys.length > 0) await raw.del(...keys);
    await store.close();
    await raw.quit();
  });

  it("uses the axs:rl: namespace and writes keys under the store prefix only", async () => {
    expect(REDIS_RATE_LIMIT_PREFIX).toBe("axs:rl:");
    setRateLimitStore(store);
    const r = RATE_LIMITS.signInEmail(`${randomBytes(4).toString("hex")}@example.test`);
    await attempt(db, r);
    expect(await raw.exists(PREFIX + r.key)).toBe(1);
    expect(await raw.get(PREFIX + r.key)).toBe("1");
  });

  it("increment counts within one window and never extends it (PEXPIRE NX semantics)", async () => {
    const key = uniqueKey("inc");
    const t1 = new Date();
    const first = await store.increment(key, 60, t1);
    expect(first.count).toBe(1);
    expect(first.resetAt.getTime() - t1.getTime()).toBeGreaterThan(59_000);
    expect(first.resetAt.getTime() - t1.getTime()).toBeLessThanOrEqual(60_000);
    await sleep(150);
    const second = await store.increment(key, 60, new Date());
    expect(second.count).toBe(2);
    expect(Math.abs(second.resetAt.getTime() - first.resetAt.getTime())).toBeLessThan(60);
    const pttl = await raw.pttl(PREFIX + key);
    expect(pttl).toBeGreaterThan(59_000);
    expect(pttl).toBeLessThanOrEqual(59_850);
  });

  it("50 parallel increments are atomic (50 distinct counts)", async () => {
    const key = uniqueKey("inc-par");
    const now = new Date();
    const states = await Promise.all(Array.from({ length: 50 }, () => store.increment(key, 60, now)));
    expect(new Set(states.map((s) => s.count)).size).toBe(50);
    expect(Math.max(...states.map((s) => s.count))).toBe(50);
  });

  it("consume admits up to the limit and refuses further attempts without counting them", async () => {
    const key = uniqueKey("consume");
    const now = new Date();
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await store.consume(key, 3, 60, now));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.state.count)).toEqual([1, 2, 3, 3, 3]);
    expect(await raw.get(PREFIX + key)).toBe("3");
  });

  it("50 parallel consumes never exceed the limit, also across two connections (two app servers)", async () => {
    const key = uniqueKey("consume-par");
    const now = new Date();
    const outcomes = await Promise.all(Array.from({ length: 50 }, () => store.consume(key, 10, 60, now)));
    expect(outcomes.filter((o) => o.allowed)).toHaveLength(10);
    expect(new Set(outcomes.filter((o) => o.allowed).map((o) => o.state.count))).toEqual(
      new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
    );
    expect(await raw.get(PREFIX + key)).toBe("10");

    const other = new RedisRateLimitStore(REDIS_URL, { prefix: PREFIX });
    try {
      const shared = uniqueKey("consume-two");
      const both = await Promise.all(
        Array.from({ length: 50 }, (_, i) => (i % 2 === 0 ? store : other).consume(shared, 10, 60, new Date())),
      );
      expect(both.filter((o) => o.allowed)).toHaveLength(10);
      expect(await raw.get(PREFIX + shared)).toBe("10");
    } finally {
      await other.close();
    }
  });

  it("enforceAttempts lets exactly `limit` of 50 parallel secret checks run", async () => {
    setRateLimitStore(store);
    const perUser = rule("signin-user", 5, 900);
    const perIp = rule("signin-ip", 20, 900);
    let checks = 0;
    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, async () => {
        await enforceAttempts(db, [perIp, perUser]);
        checks += 1;
      }),
    );
    expect(checks).toBe(5);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(rejected).toHaveLength(45);
    for (const r of rejected) expect((r.reason as ApiError).status).toBe(429);
    // Attempts refused per user gave their per-IP slot back (refund under concurrency): only 5 stay counted.
    expect(await raw.get(PREFIX + perIp.key)).toBe("5");
  });

  it("Retry-After and resetAt are the bucket's remaining TTL", async () => {
    setRateLimitStore(store);
    const r = rule("retry", 2, 60);
    await attempt(db, r);
    await attempt(db, r);
    const now = new Date();
    const refused = await attempt(db, r, now);
    const pttl = await raw.pttl(PREFIX + r.key);
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
    expect(refused.retryAfterSec).toBe(Math.ceil(pttl / 1000));
    expect(refused.retryAfterSec).toBeGreaterThanOrEqual(59);
    expect(refused.retryAfterSec).toBeLessThanOrEqual(60);
    expect(Math.abs(refused.resetAt.getTime() - (now.getTime() + pttl))).toBeLessThan(100);

    const err = await enforceAttempts(db, [r]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(429);
    expect(Number((err as ApiError).headers?.["Retry-After"])).toBe(refused.retryAfterSec);
  });

  it("the window resets after windowSec (fixed window, Redis TTL)", async () => {
    const key = uniqueKey("window");
    expect((await store.consume(key, 2, 1, new Date())).allowed).toBe(true);
    expect((await store.consume(key, 2, 1, new Date())).allowed).toBe(true);
    const refused = await store.consume(key, 2, 1, new Date());
    expect(refused.allowed).toBe(false);
    const wait = refused.state.resetAt.getTime() - Date.now();
    expect(wait).toBeLessThanOrEqual(1000);
    await sleep(Math.max(0, wait) + 60);
    const now = new Date();
    const fresh = await store.consume(key, 2, 1, now);
    expect(fresh).toMatchObject({ allowed: true, state: { count: 1 } });
    expect(fresh.state.resetAt.getTime() - now.getTime()).toBeGreaterThan(900);

    const incKey = uniqueKey("window-inc");
    await store.increment(incKey, 1, new Date());
    await sleep(1_100);
    expect((await store.increment(incKey, 1, new Date())).count).toBe(1);
  });

  it("refund frees one slot, keeps the window and never goes below 0", async () => {
    const key = uniqueKey("refund");
    const now = new Date();
    await store.consume(key, 2, 60, now);
    await store.consume(key, 2, 60, now);
    expect((await store.consume(key, 2, 60, now)).allowed).toBe(false);
    await store.refund(key, now);
    expect(await raw.get(PREFIX + key)).toBe("1");
    expect(await raw.pttl(PREFIX + key)).toBeGreaterThan(58_000);
    expect((await store.consume(key, 2, 60, now)).allowed).toBe(true);

    await store.refund(key, now);
    await store.refund(key, now);
    await store.refund(key, now);
    await store.refund(key, now);
    expect(await raw.get(PREFIX + key)).toBe("0");
    expect(await raw.pttl(PREFIX + key)).toBeGreaterThan(58_000);

    const missing = uniqueKey("refund-missing");
    await store.refund(missing, now);
    expect(await raw.exists(PREFIX + missing)).toBe(0);
  });

  it("parallel refunds never take a bucket below 0", async () => {
    const key = uniqueKey("refund-par");
    const now = new Date();
    for (let i = 0; i < 3; i += 1) await store.consume(key, 5, 60, now);
    setRateLimitStore(store);
    await Promise.all(Array.from({ length: 20 }, () => refund(db, { key, limit: 5, windowSec: 60 }, now)));
    expect(await raw.get(PREFIX + key)).toBe("0");
  });

  it("clear deletes the bucket; peek and get read without counting", async () => {
    setRateLimitStore(store);
    const r = rule("clear", 2, 60);
    expect(await peek(db, r)).toMatchObject({ allowed: true, count: 0 });
    expect(await store.get(r.key, new Date())).toBeNull();
    await attempt(db, r);
    await attempt(db, r);
    expect(await peek(db, r)).toMatchObject({ allowed: false, count: 2, remaining: 0 });
    expect(await raw.get(PREFIX + r.key)).toBe("2");
    expect((await attempt(db, r)).allowed).toBe(false);
    await clear(db, r.key);
    expect(await raw.exists(PREFIX + r.key)).toBe(0);
    expect(await attempt(db, r)).toMatchObject({ allowed: true, count: 1 });
  });

  it("hit() reports over-limit hits through increment()", async () => {
    setRateLimitStore(store);
    const r = rule("hit", 2, 60);
    const results = [await hit(db, r), await hit(db, r), await hit(db, r)];
    expect(results.map((x) => x.allowed)).toEqual([true, true, false]);
    expect(results[2]?.retryAfterSec).toBeGreaterThanOrEqual(59);
  });

  it("repairs a bucket that has no expiry instead of locking it forever", async () => {
    const key = uniqueKey("no-ttl");
    await raw.set(PREFIX + key, "5");
    const refused = await store.consume(key, 5, 2, new Date());
    expect(refused.allowed).toBe(false);
    const pttl = await raw.pttl(PREFIX + key);
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(2_000);
  });

  it("purgeExpired has nothing to do (Redis expires buckets)", async () => {
    expect(await store.purgeExpired(new Date())).toBe(0);
  });

  it("installRedisRateLimitStore registers one store per process", async () => {
    const opts = { prefix: `${PREFIX}install:` };
    const first = installRedisRateLimitStore(REDIS_URL, opts);
    try {
      expect(installRedisRateLimitStore(REDIS_URL, opts)).toBe(first);
      const r = rule("installed", 5, 60);
      await hit(db, r);
      expect(await raw.get(`${PREFIX}install:${r.key}`)).toBe("1");
    } finally {
      await uninstallRedisRateLimitStore();
    }
  });
});

describe("failure policy when Redis is unreachable", () => {
  let dead: RedisRateLimitStore;
  let lines: string[];
  let restoreSink: ReturnType<typeof setLogSink>;
  const secretKey = `signin:email:${randomBytes(16).toString("hex")}`;

  beforeAll(async () => {
    lines = [];
    restoreSink = setLogSink((_level, line) => lines.push(line));
    dead = new RedisRateLimitStore(`redis://127.0.0.1:${await closedPort()}`, {
      prefix: PREFIX,
      connectTimeoutMs: 300,
      commandTimeoutMs: 200,
    });
  });

  afterAll(async () => {
    await dead.close();
    setLogSink(restoreSink);
  });

  const expectUnavailable = (e: unknown) => {
    expect(e).toBeInstanceOf(ApiError);
    const err = e as ApiError;
    expect(err.status).toBe(503);
    expect(err.code).toBe("unavailable");
    expect(err.headers?.["Retry-After"]).toBe("5");
  };

  it("fails CLOSED for secret checks: consume/attempt/enforceAttempts answer 503 unavailable, quickly", async () => {
    setRateLimitStore(dead);
    const started = Date.now();
    expectUnavailable(await dead.consume(secretKey, 5, 900, new Date()).catch((e: unknown) => e));
    expectUnavailable(await attempt(db, { key: secretKey, limit: 5, windowSec: 900 }).catch((e: unknown) => e));
    expectUnavailable(
      await enforceAttempts(db, [{ key: secretKey, limit: 5, windowSec: 900 }]).then(
        () => null,
        (e: unknown) => e,
      ),
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("fails CLOSED for reads: get/peek answer 503 unavailable", async () => {
    setRateLimitStore(dead);
    expectUnavailable(await dead.get(secretKey, new Date()).catch((e: unknown) => e));
    expectUnavailable(await peek(db, { key: secretKey, limit: 5, windowSec: 900 }).catch((e: unknown) => e));
  });

  it("fails OPEN but degraded for plain limits: hit() keeps counting per process", async () => {
    setRateLimitStore(dead);
    const r: RateLimitRule = { key: uniqueKey("degraded"), limit: 3, windowSec: 60 };
    const now = new Date();
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await hit(db, r, now));
    expect(results.map((x) => x.allowed)).toEqual([true, true, true, false, false]);
    expect(results[3]?.retryAfterSec).toBe(60);
    // A new window starts once the local one has ended.
    expect((await hit(db, r, new Date(now.getTime() + 60_000))).count).toBe(1);
  });

  it("refund and clear are best effort (no throw; the attempt simply stays counted)", async () => {
    setRateLimitStore(dead);
    await expect(dead.refund(secretKey, new Date())).resolves.toBeUndefined();
    await expect(clear(db, secretKey)).resolves.toBeUndefined();
    await expect(refund(db, { key: secretKey, limit: 5, windowSec: 900 })).resolves.toBeUndefined();
  });

  it("logs the outage at most once per 10 s, without bucket keys or the Redis URL", () => {
    const events = lines.map((l) => JSON.parse(l) as { event: string; op?: string; level: string });
    const outages = events.filter((e) => e.event === "rate_limit_store_unavailable");
    expect(outages).toHaveLength(1);
    expect(outages[0]?.level).toBe("error");
    for (const l of lines) {
      expect(l).not.toContain(secretKey);
      expect(l).not.toContain(PREFIX);
      expect(l).not.toMatch(/redis:\/\//);
    }
  });

  it("validates arguments before touching Redis", async () => {
    await expect(dead.consume("", 5, 60, new Date())).rejects.toThrow(RangeError);
    await expect(dead.consume("k", 0, 60, new Date())).rejects.toThrow(RangeError);
    await expect(dead.increment("k", 1.5, new Date())).rejects.toThrow(RangeError);
  });
});

describe("separate module copies (Next.js bundles instrumentation.ts and the route handlers separately)", () => {
  it("a store registered through one copy of rate-limit.ts is used by every other copy", async () => {
    vi.resetModules();
    const registering = await import("@/lib/auth/rate-limit");
    vi.resetModules();
    const routeCopy = await import("@/lib/auth/rate-limit");
    expect(routeCopy.setRateLimitStore).not.toBe(registering.setRateLimitStore);
    const memory = memoryRateLimitStore();
    registering.setRateLimitStore(memory);
    try {
      await routeCopy.hit(db, { key: "copy:check", limit: 5, windowSec: 60 });
      expect(memory.buckets.get("copy:check")?.count).toBe(1);
    } finally {
      registering.setRateLimitStore(null);
    }
  });

  it("the store's 503 from another copy of lib/http keeps its status, code and Retry-After in errorResponse()", async () => {
    vi.resetModules();
    const routeHttp = await import("@/lib/http");
    vi.resetModules();
    const instrumentCopy = await import("@/lib/auth/rate-limit-redis");
    const err = instrumentCopy.rateLimitUnavailable();
    expect(err).toBeInstanceOf(routeHttp.ApiError);
    const res = routeHttp.errorResponse(err);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: { code: "unavailable", message: instrumentCopy.RATE_LIMIT_UNAVAILABLE_MESSAGE, retryAfterSec: 5 },
    });
    expect({ status: 503, code: "unavailable", message: "look-alike" }).not.toBeInstanceOf(routeHttp.ApiError);
  });
});
