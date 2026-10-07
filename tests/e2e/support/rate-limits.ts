/**
 * With TRUSTED_PROXY_HOPS=0 (development) every local request shares the "unknown" client-IP rate-limit buckets
 * (lib/auth/rate-limit.ts keys "<flow>:ip:<sha256('unknown')[0,32]>"), so a few local runs in a row would hit the
 * per-IP limits (5 registrations an hour, 20 orders an hour...). Like scripts/check-*.mjs, the suite deletes those
 * buckets before it runs, on local servers only: the Postgres rows (the store without REDIS_URL) and, best effort,
 * the same keys in a local Redis (`axs:rl:` prefix, lib/auth/rate-limit-redis.ts) when one answers.
 */
import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type { Db } from "./db";
import { IS_LOCAL } from "./env";

const UNKNOWN_IP_ID = createHash("sha256").update("unknown").digest("hex").slice(0, 32);

export async function resetSharedIpBuckets(db: Db): Promise<{ postgres: number; redis: number | null }> {
  if (!IS_LOCAL) return { postgres: 0, redis: null };
  const postgres = await db.exec(`DELETE FROM "RateLimitBucket" WHERE "key" LIKE $1`, [`%:ip:${UNKNOWN_IP_ID}`]);
  return { postgres, redis: await resetRedis() };
}

async function resetRedis(): Promise<number | null> {
  const url = process.env.E2E_REDIS_URL ?? "redis://127.0.0.1:6379";
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) return null;
  const redis = new Redis(url, { lazyConnect: true, connectTimeout: 1_000, commandTimeout: 2_000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    let removed = 0;
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `axs:rl:*:ip:${UNKNOWN_IP_ID}`, "COUNT", 500);
      cursor = next;
      if (keys.length) removed += await redis.del(...keys);
    } while (cursor !== "0");
    return removed;
  } catch {
    return null;
  } finally {
    redis.disconnect();
  }
}
