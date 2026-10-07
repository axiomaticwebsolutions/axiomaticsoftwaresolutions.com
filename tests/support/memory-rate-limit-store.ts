import type { BucketState, RateLimitStore } from "@/lib/auth/rate-limit";

/** Resolves on a later macrotask, so concurrent callers interleave like network round trips do. */
const roundTrip = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * In-memory RateLimitStore for unit tests (single process only; never for production). Every call waits one round
 * trip before and after its read-modify-write, which itself runs without an await, so it is atomic per key just as
 * the Postgres and Redis stores are, while concurrent callers still interleave between calls.
 */
export function memoryRateLimitStore(): RateLimitStore & { buckets: Map<string, BucketState> } {
  const buckets = new Map<string, BucketState>();

  const live = (key: string, now: Date): BucketState | null => {
    const bucket = buckets.get(key);
    return bucket && bucket.resetAt.getTime() > now.getTime() ? bucket : null;
  };

  const add = (key: string, windowSec: number, now: Date): BucketState => {
    const bucket = live(key, now);
    const next = bucket
      ? { count: bucket.count + 1, resetAt: bucket.resetAt }
      : { count: 1, resetAt: new Date(now.getTime() + windowSec * 1000) };
    buckets.set(key, next);
    return { ...next };
  };

  return {
    buckets,
    async increment(key, windowSec, now) {
      await roundTrip();
      const state = add(key, windowSec, now);
      await roundTrip();
      return state;
    },
    async consume(key, limit, windowSec, now) {
      await roundTrip();
      const bucket = live(key, now);
      const result = bucket && bucket.count >= limit ? { allowed: false, state: { ...bucket } } : { allowed: true, state: add(key, windowSec, now) };
      await roundTrip();
      return result;
    },
    async refund(key, now) {
      await roundTrip();
      const bucket = live(key, now);
      if (bucket && bucket.count > 0) buckets.set(key, { count: bucket.count - 1, resetAt: bucket.resetAt });
    },
    async get(key, now) {
      await roundTrip();
      const bucket = live(key, now);
      return bucket ? { ...bucket } : null;
    },
    async delete(key) {
      await roundTrip();
      buckets.delete(key);
    },
    async purgeExpired(now) {
      await roundTrip();
      let removed = 0;
      for (const [key, bucket] of buckets) {
        if (bucket.resetAt.getTime() <= now.getTime()) {
          buckets.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
