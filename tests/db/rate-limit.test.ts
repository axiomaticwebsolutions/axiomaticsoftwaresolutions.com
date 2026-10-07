import { beforeEach, describe, expect, it } from "vitest";
import {
  RATE_LIMITS,
  attempt,
  clear,
  enforce,
  enforceAttempts,
  hit,
  peek,
  purgeExpired,
  refund,
  type RateLimitRule,
} from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";

const T0 = new Date("2026-10-06T06:30:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

beforeEach(async () => {
  await db.rateLimitBucket.deleteMany({});
});

describe("sign-in attempts (5 per 15 minutes per email)", () => {
  it("counts each attempt before the password check and refuses the 6th", async () => {
    const rule = RATE_LIMITS.signInEmail("Priya@SharmaMedicals.example");
    for (let i = 1; i <= 5; i += 1) {
      expect(await attempt(db, rule, at(i))).toMatchObject({ allowed: true, count: i, remaining: 5 - i });
    }
    const sixth = await attempt(db, rule, at(10));
    expect(sixth).toMatchObject({ allowed: false, count: 5 });
    // The window opened at the first attempt (t = 1 s) and ends 15 minutes later.
    expect(sixth.retryAfterSec).toBe(15 * 60 + 1 - 10);

    let caught: unknown = null;
    try {
      enforce(sixth);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(429);
    expect((caught as ApiError).code).toBe("too_many_attempts");
    expect((caught as ApiError).headers?.["Retry-After"]).toBe(String(sixth.retryAfterSec));
    // Refused attempts are not counted.
    expect((await peek(db, rule, at(11))).count).toBe(5);
  });

  it("is atomic under concurrency: 50 parallel attempts admit exactly 5", async () => {
    const rule = RATE_LIMITS.signInEmail("burst@example.test");
    const results = await Promise.all(Array.from({ length: 50 }, () => attempt(db, rule, at(5))));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect((await db.rateLimitBucket.findUniqueOrThrow({ where: { key: rule.key } })).count).toBe(5);
  });

  it("enforceAttempts refunds earlier buckets when a later one is full; refund frees a slot", async () => {
    const email = RATE_LIMITS.signInEmail("priya@sharmamedicals.example");
    const ip: RateLimitRule = { key: "test:ip", limit: 1, windowSec: 900 };
    await enforceAttempts(db, [email, ip], at(0));
    await expect(enforceAttempts(db, [email, ip], at(1))).rejects.toMatchObject({ status: 429 });
    expect((await peek(db, email, at(2))).count).toBe(1);
    await refund(db, ip, at(3));
    await enforceAttempts(db, [email, ip], at(4));
    expect((await peek(db, email, at(5))).count).toBe(2);
    await refund(db, ip, at(6));
    await refund(db, ip, at(6));
    expect((await peek(db, ip, at(7))).count).toBe(0);
  });

  it("uses hashed, case-insensitive identities in bucket keys", () => {
    const a = RATE_LIMITS.signInEmail("Priya@SharmaMedicals.example");
    const b = RATE_LIMITS.signInEmail(" priya@sharmamedicals.example ");
    expect(a.key).toBe(b.key);
    expect(a.key).not.toContain("priya");
    expect(RATE_LIMITS.activateIp("103.21.44.17").key).not.toContain("103.21");
  });
});

describe("windows", () => {
  const rule: RateLimitRule = { key: "test:window", limit: 2, windowSec: 60 };

  it("counts within a window and starts a fresh one after resetAt", async () => {
    expect(await hit(db, rule, at(0))).toMatchObject({ allowed: true, count: 1, resetAt: at(60) });
    expect(await hit(db, rule, at(30))).toMatchObject({ allowed: true, count: 2, resetAt: at(60) });
    expect(await hit(db, rule, at(59))).toMatchObject({ allowed: false, count: 3, retryAfterSec: 1 });
    expect(await hit(db, rule, at(60))).toMatchObject({ allowed: true, count: 1, resetAt: at(120) });
  });

  it("attempt restarts an ended window even when the old one was full", async () => {
    await attempt(db, rule, at(0));
    await attempt(db, rule, at(1));
    expect((await attempt(db, rule, at(2))).allowed).toBe(false);
    expect(await attempt(db, rule, at(60))).toMatchObject({ allowed: true, count: 1, resetAt: at(120) });
  });

  it("peek does not count and treats an expired bucket as empty", async () => {
    await hit(db, rule, at(0));
    expect(await peek(db, rule, at(1))).toMatchObject({ allowed: true, count: 1, remaining: 1 });
    expect(await peek(db, rule, at(1))).toMatchObject({ count: 1 });
    expect(await peek(db, rule, at(61))).toMatchObject({ allowed: true, count: 0, remaining: 2 });
  });

  it("hit is atomic under concurrency: 20 parallel hits produce counts 1..20", async () => {
    const big: RateLimitRule = { key: "test:concurrent", limit: 100, windowSec: 60 };
    const results = await Promise.all(Array.from({ length: 20 }, () => hit(db, big, at(5))));
    expect(results.map((r) => r.count).sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});

describe("clear and purge", () => {
  it("clear forgets a bucket", async () => {
    const rule = RATE_LIMITS.keyReveal("user_1");
    for (let i = 0; i < 5; i += 1) await attempt(db, rule, at(i));
    expect((await attempt(db, rule, at(6))).allowed).toBe(false);
    await clear(db, rule.key);
    expect(await peek(db, rule, at(7))).toMatchObject({ allowed: true, count: 0 });
  });

  it("purgeExpired removes only ended windows", async () => {
    await hit(db, { key: "test:short", limit: 5, windowSec: 10 }, at(0));
    await hit(db, { key: "test:long", limit: 5, windowSec: 3600 }, at(0));
    expect(await purgeExpired(db, at(11))).toBe(1);
    expect((await db.rateLimitBucket.findMany({})).map((b) => b.key)).toEqual(["test:long"]);
  });
});
