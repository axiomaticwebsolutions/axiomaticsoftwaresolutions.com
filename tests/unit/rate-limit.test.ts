import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import type { Db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { memoryRateLimitStore } from "../support/memory-rate-limit-store";

// The registered store handles every call, so the db handle is never touched.
const db = undefined as unknown as Db;
const T0 = new Date("2026-10-06T06:30:00.000Z");
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);
const argon2Delay = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

let store: ReturnType<typeof memoryRateLimitStore>;

beforeEach(() => {
  store = memoryRateLimitStore();
  setRateLimitStore(store);
});

afterEach(() => {
  setRateLimitStore(null);
});

/** The sign-in flow as the module documents it: count first, verify, then clear/refund on success. */
function signInFlow(counter: { checks: number }) {
  const email = "priya@sharmamedicals.example";
  const ip = "103.21.44.17";
  return async (password: string, now: Date): Promise<boolean> => {
    await enforceAttempts(db, [RATE_LIMITS.signInEmail(email), RATE_LIMITS.signInIp(ip)], now);
    counter.checks += 1;
    await argon2Delay();
    if (password !== "correct horse 42") return false;
    await clear(db, RATE_LIMITS.signInEmail(email).key);
    await refund(db, RATE_LIMITS.signInIp(ip), now);
    return true;
  };
}

describe("attempt-before-verify under concurrency", () => {
  it("200 parallel wrong passwords run at most 5 password checks; the rest get 429", async () => {
    const counter = { checks: 0 };
    const signIn = signInFlow(counter);
    const outcomes = await Promise.allSettled(Array.from({ length: 200 }, () => signIn("wrong", at(1))));

    expect(counter.checks).toBe(5);
    const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === "rejected");
    expect(rejected).toHaveLength(195);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(ApiError);
      expect((r.reason as ApiError).status).toBe(429);
    }
    // Refused attempts are not counted, and they never reach the IP bucket: both sit at 5.
    expect((await peek(db, RATE_LIMITS.signInEmail("priya@sharmamedicals.example"), at(2))).count).toBe(5);
    expect((await peek(db, RATE_LIMITS.signInIp("103.21.44.17"), at(2))).count).toBe(5);
  });

  it("the 6th sequential attempt is refused before the password is checked", async () => {
    const counter = { checks: 0 };
    const signIn = signInFlow(counter);
    for (let i = 1; i <= 5; i += 1) expect(await signIn("wrong", at(i))).toBe(false);
    await expect(signIn("correct horse 42", at(6))).rejects.toMatchObject({ status: 429, code: "too_many_attempts" });
    expect(counter.checks).toBe(5);
    // A new window admits attempts again, and a success clears the email bucket and refunds the IP slot.
    expect(await signIn("correct horse 42", at(15 * 60 + 1))).toBe(true);
    expect(await peek(db, RATE_LIMITS.signInEmail("priya@sharmamedicals.example"), at(15 * 60 + 2))).toMatchObject({ count: 0 });
    expect(await peek(db, RATE_LIMITS.signInIp("103.21.44.17"), at(15 * 60 + 2))).toMatchObject({ count: 0 });
  });
});

describe("attempt / refund", () => {
  const rule: RateLimitRule = { key: "test:attempt", limit: 2, windowSec: 60 };

  it("counts only while there is room and reports Retry-After when full", async () => {
    expect(await attempt(db, rule, at(0))).toMatchObject({ allowed: true, count: 1, remaining: 1 });
    expect(await attempt(db, rule, at(1))).toMatchObject({ allowed: true, count: 2, remaining: 0 });
    expect(await attempt(db, rule, at(2))).toMatchObject({ allowed: false, count: 2, retryAfterSec: 58 });
    expect(await attempt(db, rule, at(3))).toMatchObject({ allowed: false, count: 2 });
    expect(await attempt(db, rule, at(60))).toMatchObject({ allowed: true, count: 1, resetAt: at(120) });
  });

  it("refund frees one slot, never goes below zero and ignores ended windows", async () => {
    await attempt(db, rule, at(0));
    await attempt(db, rule, at(0));
    await refund(db, rule, at(1));
    expect(await attempt(db, rule, at(2))).toMatchObject({ allowed: true, count: 2 });
    await refund(db, rule, at(3));
    await refund(db, rule, at(3));
    await refund(db, rule, at(3));
    expect(store.buckets.get(rule.key)?.count).toBe(0);
    await refund(db, rule, at(61));
    expect(store.buckets.get(rule.key)?.count).toBe(0);
  });

  it("enforceAttempts gives back earlier attempts when a later rule is used up", async () => {
    const first: RateLimitRule = { key: "test:first", limit: 5, windowSec: 60 };
    const second: RateLimitRule = { key: "test:second", limit: 1, windowSec: 60 };
    await enforceAttempts(db, [first, second], at(0));
    await expect(enforceAttempts(db, [first, second], at(1))).rejects.toMatchObject({ status: 429 });
    expect(store.buckets.get(first.key)?.count).toBe(1);
    expect(store.buckets.get(second.key)?.count).toBe(1);
  });

  it("plain hit() keeps counting past the limit", async () => {
    const plain: RateLimitRule = { key: "test:plain", limit: 1, windowSec: 60 };
    expect(await hit(db, plain, at(0))).toMatchObject({ allowed: true, count: 1 });
    expect(await hit(db, plain, at(1))).toMatchObject({ allowed: false, count: 2 });
  });

  it("rejects malformed rules", async () => {
    await expect(attempt(db, { key: "", limit: 1, windowSec: 1 }, at(0))).rejects.toThrow(RangeError);
    await expect(refund(db, { key: "k", limit: 0, windowSec: 1 }, at(0))).rejects.toThrow(RangeError);
  });
});
