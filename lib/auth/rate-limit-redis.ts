/**
 * Redis RateLimitStore: the production store (decisions.md "Scale" / Phase 4). Registered once per server process
 * by `instrumentation.ts` when REDIS_URL is set; without it the Postgres buckets in rate-limit.ts stay in use
 * (development only; lib/env.ts requires REDIS_URL when NODE_ENV=production).
 *
 * Windows are fixed and live in Redis: a bucket is one integer key `axs:rl:<rule key>` whose TTL is the window.
 * Every read-modify-write is a single Lua script (atomic per key, one round trip):
 * - increment: INCR, then PEXPIRE only when the key has no expiry yet (PEXPIRE NX semantics, written as a PTTL
 *   check so it also runs on Redis < 7). Later hits never extend the window.
 * - consume: GET; only when the live count is below the limit INCR + PEXPIRE-if-none. A full bucket is returned
 *   unchanged, so refused attempts are not counted and N parallel callers get at most `limit` admissions.
 * - refund: DECR a live key whose count is above 0 (DECR keeps the TTL); a missing key is left alone.
 * Expired keys disappear on their own, so purgeExpired() has nothing to do. The window clock is the Redis
 * server's: `now` only anchors the returned resetAt (now + PTTL), so app servers with skewed clocks still share
 * exactly one window per key, and Retry-After is the real remaining TTL.
 *
 * Failure policy when Redis is unreachable, slow (command timeout) or answers with an error:
 * - consume() and get() FAIL CLOSED: they throw 503 `unavailable` (Retry-After 5). consume() backs attempt() and
 *   enforceAttempts(), i.e. every limit counted before a check: sign-in, emailed codes, key reveal, password
 *   checks, payment-return signatures and the device API (activate, validate, deactivate); get() backs peek(), which
 *   those flows read. A secret check never runs unlimited. The apps ride out such an outage on their signed
 *   activation token (offline grace), so a 503 from /validate costs no customer anything.
 * - increment() FAILS OPEN to a degraded per-process window: hit() limits (register, contact, quotes and coupons,
 *   order status and actions, invoice PDFs, downloads, invalid-webhook bookkeeping) keep counting in this process's
 *   memory, so they still bite per server (effective limit = limit x servers) while Redis is down.
 * - refund() and delete() are best effort: a failure leaves the attempt counted, i.e. errs on the strict side.
 * Failures are logged as `rate_limit_store_unavailable` at most once per 10 s per process (with a count of the
 * suppressed ones). Bucket keys and credentials are never logged (errors name the Redis host and port at most).
 * While ioredis is reconnecting the store fails fast instead of queueing; otherwise each command is bounded by a
 * short command timeout, so a dead Redis costs a request at most `commandTimeoutMs`.
 *
 * Keys contain hashed identifiers only (rate-limit.ts builds them). Single-key scripts, so Redis Cluster works too.
 */
import { Redis, type RedisOptions } from "ioredis";
import { setRateLimitStore, type BucketState, type RateLimitStore } from "@/lib/auth/rate-limit";
import { ApiError } from "@/lib/http";
import { log } from "@/lib/log";

export const REDIS_RATE_LIMIT_PREFIX = "axs:rl:";
export const RATE_LIMIT_UNAVAILABLE_CODE = "unavailable";
export const RATE_LIMIT_UNAVAILABLE_MESSAGE = "We can\u2019t check this request right now. Please try again in a moment.";
export const RATE_LIMIT_UNAVAILABLE_RETRY_SEC = 5;

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 500;
const DEFAULT_FALLBACK_MAX_BUCKETS = 10_000;
const FAILURE_LOG_INTERVAL_MS = 10_000;

/** 503 `unavailable` thrown when a fail-closed operation cannot reach Redis. */
export function rateLimitUnavailable(): ApiError {
  return new ApiError(503, RATE_LIMIT_UNAVAILABLE_CODE, RATE_LIMIT_UNAVAILABLE_MESSAGE, {
    details: { retryAfterSec: RATE_LIMIT_UNAVAILABLE_RETRY_SEC },
    headers: { "Retry-After": String(RATE_LIMIT_UNAVAILABLE_RETRY_SEC) },
  });
}

// KEYS[1] bucket; ARGV[1] window ms. Returns { count, pttl }.
const INCREMENT_LUA = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

// KEYS[1] bucket; ARGV[1] limit; ARGV[2] window ms. Returns { allowed (1|0), count, pttl }.
// A full bucket without an expiry (never written by this store) gets one, so it can never lock a key forever.
const CONSUME_LUA = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
if current >= limit then
  local ttl = redis.call('PTTL', KEYS[1])
  if ttl < 0 then
    redis.call('PEXPIRE', KEYS[1], window)
    ttl = window
  end
  return { 0, current, ttl }
end
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], window)
  ttl = window
end
return { 1, count, ttl }
`;

// KEYS[1] bucket. Returns the new count, or -1 when the key is missing or already at 0.
const REFUND_LUA = `
local current = tonumber(redis.call('GET', KEYS[1]) or '')
if current == nil or current <= 0 then
  return -1
end
return redis.call('DECR', KEYS[1])
`;

// KEYS[1] bucket. Returns { count, pttl } or nil when the key is missing.
const GET_LUA = `
local value = redis.call('GET', KEYS[1])
if not value then
  return false
end
return { tonumber(value) or 0, redis.call('PTTL', KEYS[1]) }
`;

type ScriptCall = (key: string, ...args: Array<string | number>) => Promise<unknown>;
type ScriptedRedis = Redis & {
  axsRlIncrement: ScriptCall;
  axsRlConsume: ScriptCall;
  axsRlRefund: ScriptCall;
  axsRlGet: ScriptCall;
};

export type RedisRateLimitStoreOptions = {
  /** Key namespace (default "axs:rl:"). Tests use their own prefix and delete only those keys. */
  prefix?: string;
  /** TCP + handshake timeout per connection attempt (default 2000 ms). */
  connectTimeoutMs?: number;
  /** Upper bound for one command, including time spent queued while connecting (default 500 ms). */
  commandTimeoutMs?: number;
  /** Size bound of the per-process fallback used by increment() while Redis is down (default 10,000 buckets). */
  fallbackMaxBuckets?: number;
  /** Extra ioredis options (merged last; tests only). */
  redisOptions?: RedisOptions;
};

/**
 * Fixed windows in this process's memory: the degraded mode of increment() while Redis is unreachable. Bounded:
 * when full, ended windows are dropped first, then the oldest tenth of the buckets.
 */
class LocalWindows {
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly maxBuckets: number) {}

  increment(key: string, windowSec: number, now: Date): BucketState {
    const t = now.getTime();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      this.buckets.delete(key);
      if (this.buckets.size >= this.maxBuckets) this.evict(t);
      bucket = { count: 0, resetAt: t + windowSec * 1000 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return { count: bucket.count, resetAt: new Date(bucket.resetAt) };
  }

  get size(): number {
    return this.buckets.size;
  }

  private evict(t: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetAt <= t) this.buckets.delete(key);
    const target = Math.floor(this.maxBuckets * 0.9);
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= target) break;
      this.buckets.delete(key);
    }
  }
}

function assertKey(key: string): void {
  if (typeof key !== "string" || key.length === 0) throw new RangeError("Rate limit keys must be non-empty strings.");
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${label} must be a positive integer.`);
}

function toInt(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new Error("Unexpected reply from the rate-limit script.");
  return Math.trunc(n);
}

/** Bucket from a script reply: resetAt = now + remaining TTL (a key without expiry reads as ending in 1 s). */
function stateFrom(count: unknown, ttlMs: unknown, now: Date): BucketState {
  const ttl = toInt(ttlMs);
  return { count: Math.max(0, toInt(count)), resetAt: new Date(now.getTime() + (ttl > 0 ? ttl : 1000)) };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Thrown internally when the client is reconnecting: fail fast instead of queueing behind a dead connection. */
class RedisDownError extends Error {
  constructor(status: string) {
    super(`Redis connection is ${status}`);
    this.name = "RedisDownError";
  }
}

export class RedisRateLimitStore implements RateLimitStore {
  readonly prefix: string;
  private readonly redis: ScriptedRedis;
  private readonly fallback: LocalWindows;
  private lastFailureLogAt = Number.NEGATIVE_INFINITY;
  private suppressedFailures = 0;
  private degraded = false;

  /** `url` is redis:// or rediss:// (TLS). Nothing connects until the first command or connect(). */
  constructor(url: string, opts: RedisRateLimitStoreOptions = {}) {
    this.prefix = opts.prefix ?? REDIS_RATE_LIMIT_PREFIX;
    this.fallback = new LocalWindows(opts.fallbackMaxBuckets ?? DEFAULT_FALLBACK_MAX_BUCKETS);
    const redis = new Redis(url, {
      lazyConnect: true,
      connectTimeout: opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      commandTimeout: opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      // A command caught by a dropped connection is retried once after reconnecting, then rejected.
      maxRetriesPerRequest: 1,
      // Reconnect forever with a capped backoff; meanwhile commands fail fast (client()).
      retryStrategy: (times: number) => Math.min(times * 200, 2_000),
      ...opts.redisOptions,
    }) as ScriptedRedis;
    redis.defineCommand("axsRlIncrement", { numberOfKeys: 1, lua: INCREMENT_LUA });
    redis.defineCommand("axsRlConsume", { numberOfKeys: 1, lua: CONSUME_LUA });
    redis.defineCommand("axsRlRefund", { numberOfKeys: 1, lua: REFUND_LUA });
    redis.defineCommand("axsRlGet", { numberOfKeys: 1, lua: GET_LUA, readOnly: true });
    this.redis = redis;
    // Without a listener ioredis prints every connection error to the console.
    redis.on("error", (e: unknown) => this.reportFailure("connection", e));
    redis.on("ready", () => {
      if (!this.degraded) return;
      this.degraded = false;
      log.info("rate_limit_store_recovered", { store: "redis" });
    });
  }

  /** ioredis connection status ("wait" until the first command). */
  get status(): string {
    return this.redis.status;
  }

  async increment(key: string, windowSec: number, now: Date): Promise<BucketState> {
    assertKey(key);
    assertPositiveInt(windowSec, "windowSec");
    try {
      const reply = (await this.client().axsRlIncrement(this.prefix + key, windowSec * 1000)) as unknown[];
      return stateFrom(reply[0], reply[1], now);
    } catch (e) {
      // Fail open, but degraded: keep counting in this process (see the module comment).
      this.reportFailure("increment", e);
      return this.fallback.increment(key, windowSec, now);
    }
  }

  async consume(key: string, limit: number, windowSec: number, now: Date): Promise<{ allowed: boolean; state: BucketState }> {
    assertKey(key);
    assertPositiveInt(limit, "limit");
    assertPositiveInt(windowSec, "windowSec");
    try {
      const reply = (await this.client().axsRlConsume(this.prefix + key, limit, windowSec * 1000)) as unknown[];
      return { allowed: toInt(reply[0]) === 1, state: stateFrom(reply[1], reply[2], now) };
    } catch (e) {
      // Fail closed: consume() guards secret checks.
      this.reportFailure("consume", e);
      throw rateLimitUnavailable();
    }
  }

  async refund(key: string, _now: Date): Promise<void> {
    assertKey(key);
    try {
      await this.client().axsRlRefund(this.prefix + key);
    } catch (e) {
      // Best effort: the attempt simply stays counted.
      this.reportFailure("refund", e);
    }
  }

  async get(key: string, now: Date): Promise<BucketState | null> {
    assertKey(key);
    try {
      const reply = await this.client().axsRlGet(this.prefix + key);
      if (reply === null || reply === undefined) return null;
      const [count, ttl] = reply as unknown[];
      return stateFrom(count, ttl, now);
    } catch (e) {
      this.reportFailure("get", e);
      throw rateLimitUnavailable();
    }
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    try {
      await this.client().del(this.prefix + key);
    } catch (e) {
      // Best effort: the bucket then simply runs out at the end of its window.
      this.reportFailure("delete", e);
    }
  }

  /** Redis expires buckets itself (key TTL = window), so there is nothing to purge. */
  async purgeExpired(_now: Date): Promise<number> {
    return 0;
  }

  /** Opens the connection now (start-up warm-up). Never throws: false when Redis is not reachable yet. */
  async connect(): Promise<boolean> {
    if (this.redis.status === "ready") return true;
    if (this.redis.status !== "wait") return false;
    try {
      await this.redis.connect();
      return true;
    } catch (e) {
      this.reportFailure("connect", e);
      return false;
    }
  }

  /** Closes the connection; the store then fails every operation as "Redis down". */
  async close(): Promise<void> {
    if (this.redis.status === "ready") {
      try {
        await this.redis.quit();
        return;
      } catch {
        // fall through to a hard disconnect
      }
    }
    this.redis.disconnect();
  }

  /** The client, or RedisDownError while ioredis is between connections (fail fast instead of queueing). */
  private client(): ScriptedRedis {
    const status = this.redis.status;
    if (status === "reconnecting" || status === "close" || status === "end") throw new RedisDownError(status);
    return this.redis;
  }

  private reportFailure(op: string, e: unknown): void {
    this.degraded = true;
    const t = Date.now();
    if (t - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) {
      this.suppressedFailures += 1;
      return;
    }
    const suppressed = this.suppressedFailures;
    this.lastFailureLogAt = t;
    this.suppressedFailures = 0;
    log.error("rate_limit_store_unavailable", {
      store: "redis",
      op,
      status: this.redis.status,
      error: errorMessage(e),
      suppressed,
    });
  }
}

const INSTALLED = Symbol.for("axs.redisRateLimitStore");
type InstalledSlot = { [INSTALLED]?: RedisRateLimitStore };

/**
 * Creates the process-wide Redis store and registers it with setRateLimitStore(). Idempotent per process: repeated
 * calls (dev hot reloads, a second register()) reuse the first store, so there is one Redis connection per server.
 * Starts connecting in the background and logs `rate_limit_store_connected` once it is ready.
 */
export function installRedisRateLimitStore(url: string, opts?: RedisRateLimitStoreOptions): RedisRateLimitStore {
  const slot = globalThis as InstalledSlot;
  let store = slot[INSTALLED];
  if (!store) {
    store = new RedisRateLimitStore(url, opts);
    slot[INSTALLED] = store;
    void store.connect().then((ready) => {
      if (ready) log.info("rate_limit_store_connected", { store: "redis" });
    });
  }
  setRateLimitStore(store);
  return store;
}

/** Unregisters (back to Postgres buckets) and closes the process-wide store. For tests and shutdown hooks. */
export async function uninstallRedisRateLimitStore(): Promise<void> {
  const slot = globalThis as InstalledSlot;
  const store = slot[INSTALLED];
  delete slot[INSTALLED];
  setRateLimitStore(null);
  if (store) await store.close();
}
