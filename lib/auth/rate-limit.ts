/**
 * Fixed-window rate limits.
 *
 * Storage sits behind RateLimitStore. The Postgres store (`RateLimitBucket`, one atomic statement per call) is
 * the development default and fine for modest traffic. In production at scale (the license activation/validation
 * API alone targets ~1,000 req/s) every hit would be a row write, so production runs the Redis store
 * (lib/auth/rate-limit-redis.ts: one Lua script per call, fixed windows as key TTLs, fail-closed for secret checks),
 * which instrumentation.ts registers at start-up with setRateLimitStore() when REDIS_URL is set (required in
 * production). Callers do not change.
 *
 * Usage patterns:
 * - Plain limits (register, coupon checks, activation): `enforce(await hit(db, RATE_LIMITS.register(ip)))`.
 * - Limits that guard a secret check (sign-in, key reveal): count the attempt BEFORE verifying, e.g.
 *   `await enforceAttempts(db, [RATE_LIMITS.signInEmail(email), RATE_LIMITS.signInIp(ip)])`. On success,
 *   `clear()` the per-identity bucket and `refund()` the per-IP one, so only failures stay counted. Never clear
 *   per-IP buckets, or an attacker could reset them with their own valid account.
 *   Counting first is what makes the limit hold under concurrency: consume() refuses atomically once the live
 *   count reaches the limit, so N parallel attempts run at most `limit` password checks. Never gate a check with
 *   peek() and count after a failure: every request that arrives before the first failure is counted would pass.
 * Call these outside long transactions: the upsert holds the bucket row lock until commit.
 * Bucket keys contain hashed identifiers only, never raw emails, IPs or license keys.
 */
import type { Db } from "@/lib/db";
import { errors, ipBucket } from "@/lib/http";
import { sha256Hex } from "@/lib/auth/tokens";

export type RateLimitRule = { key: string; limit: number; windowSec: number };

export type RateLimitResult = {
  /** hit()/attempt(): this attempt is within the limit. peek(): one more attempt would be within the limit. */
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  /** Seconds until the window resets when not allowed; 0 when allowed. */
  retryAfterSec: number;
  resetAt: Date;
};

export type BucketState = { count: number; resetAt: Date };

/** Storage backend. Implementations must make increment(), consume() and refund() atomic per key. */
export interface RateLimitStore {
  /** Counts one hit: starts a fresh window (count 1) when the current one has ended, else adds 1. */
  increment(key: string, windowSec: number, now: Date): Promise<BucketState>;
  /**
   * Counts one hit only while the live count is below `limit` (an ended window always admits one and restarts).
   * Returns the bucket after counting, or `allowed: false` with the unchanged bucket when it is full.
   */
  consume(key: string, limit: number, windowSec: number, now: Date): Promise<{ allowed: boolean; state: BucketState }>;
  /** Takes back one hit from a live bucket (never below 0); a missing or ended bucket is left alone. */
  refund(key: string, now: Date): Promise<void>;
  /** The live bucket, or null when missing or expired. */
  get(key: string, now: Date): Promise<BucketState | null>;
  delete(key: string): Promise<void>;
  /** Removes expired buckets; returns how many. */
  purgeExpired(now: Date): Promise<number>;
}

type BucketRow = { count: number; resetAt: Date | string };

function toState(row: BucketRow): BucketState {
  return { count: Number(row.count), resetAt: new Date(row.resetAt) };
}

/** Postgres store on the `RateLimitBucket` table. */
export function postgresRateLimitStore(db: Db): RateLimitStore {
  async function get(key: string, now: Date): Promise<BucketState | null> {
    const row = await db.rateLimitBucket.findUnique({ where: { key } });
    if (!row || row.resetAt.getTime() <= now.getTime()) return null;
    return { count: row.count, resetAt: row.resetAt };
  }

  return {
    async increment(key, windowSec, now) {
      const freshReset = new Date(now.getTime() + windowSec * 1000);
      const rows = await db.$queryRaw<BucketRow[]>`
        INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
        VALUES (${key}, 1, ${freshReset}::timestamp(3))
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now}::timestamp(3) THEN 1
                         ELSE "RateLimitBucket"."count" + 1 END,
          "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now}::timestamp(3) THEN EXCLUDED."resetAt"
                           ELSE "RateLimitBucket"."resetAt" END
        RETURNING "count", "resetAt"`;
      const row = rows[0];
      if (!row) throw new Error("Rate limit upsert returned no row.");
      return toState(row);
    },
    async consume(key, limit, windowSec, now) {
      const freshReset = new Date(now.getTime() + windowSec * 1000);
      // ON CONFLICT DO UPDATE locks the existing row and evaluates WHERE against its latest version, so concurrent
      // callers queue on the row lock and at most `limit` of them get a row back per window.
      const rows = await db.$queryRaw<BucketRow[]>`
        INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
        VALUES (${key}, 1, ${freshReset}::timestamp(3))
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now}::timestamp(3) THEN 1
                         ELSE "RateLimitBucket"."count" + 1 END,
          "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= ${now}::timestamp(3) THEN EXCLUDED."resetAt"
                           ELSE "RateLimitBucket"."resetAt" END
        WHERE "RateLimitBucket"."resetAt" <= ${now}::timestamp(3) OR "RateLimitBucket"."count" < ${limit}::int
        RETURNING "count", "resetAt"`;
      const row = rows[0];
      if (row) return { allowed: true, state: toState(row) };
      // Full bucket. If it was cleared or ended in between, this attempt is still refused (fail closed).
      const live = await get(key, now);
      return { allowed: false, state: live ?? { count: limit, resetAt: new Date(now.getTime() + 1000) } };
    },
    async refund(key, now) {
      await db.rateLimitBucket.updateMany({
        where: { key, count: { gt: 0 }, resetAt: { gt: now } },
        data: { count: { decrement: 1 } },
      });
    },
    get,
    async delete(key) {
      await db.rateLimitBucket.deleteMany({ where: { key } });
    },
    async purgeExpired(now) {
      const { count } = await db.rateLimitBucket.deleteMany({ where: { resetAt: { lte: now } } });
      return count;
    },
  };
}

// The registered store lives on globalThis, not in a module variable: Next.js loads instrumentation.ts (which
// registers it) and the route handlers as separate module graphs, each with its own copy of this module.
const STORE_SLOT = Symbol.for("axs.rateLimitStore");
type StoreSlot = { [STORE_SLOT]?: RateLimitStore | null };

/** Registers the process-wide store (e.g. Redis in production). Pass null to fall back to Postgres. */
export function setRateLimitStore(store: RateLimitStore | null): void {
  (globalThis as StoreSlot)[STORE_SLOT] = store;
}

function storeFor(db: Db): RateLimitStore {
  return (globalThis as StoreSlot)[STORE_SLOT] ?? postgresRateLimitStore(db);
}

function assertRule(rule: RateLimitRule): void {
  if (!rule.key || !Number.isInteger(rule.limit) || rule.limit < 1 || !Number.isInteger(rule.windowSec) || rule.windowSec < 1) {
    throw new RangeError("Rate limit rules need a key, a positive integer limit and a positive integer window.");
  }
}

function toResult(rule: RateLimitRule, state: BucketState, now: Date, allowed: boolean): RateLimitResult {
  const retryAfterSec = allowed ? 0 : Math.max(1, Math.ceil((state.resetAt.getTime() - now.getTime()) / 1000));
  return {
    allowed,
    count: state.count,
    limit: rule.limit,
    remaining: Math.max(0, rule.limit - state.count),
    retryAfterSec,
    resetAt: state.resetAt,
  };
}

/** Counts one attempt. `allowed` is false once the count exceeds the limit within the window. */
export async function hit(db: Db, rule: RateLimitRule, now: Date = new Date()): Promise<RateLimitResult> {
  assertRule(rule);
  const state = await storeFor(db).increment(rule.key, rule.windowSec, now);
  return toResult(rule, state, now, state.count <= rule.limit);
}

/**
 * Counts one attempt only while the bucket has room, atomically. Use it before a secret check; a refused attempt
 * is not counted, so the count never passes the limit and refund() can free a slot.
 */
export async function attempt(db: Db, rule: RateLimitRule, now: Date = new Date()): Promise<RateLimitResult> {
  assertRule(rule);
  const { allowed, state } = await storeFor(db).consume(rule.key, rule.limit, rule.windowSec, now);
  return toResult(rule, state, now, allowed);
}

/** Gives back one attempt counted by attempt() (e.g. the per-IP sign-in slot after a successful sign-in). */
export async function refund(db: Db, rule: RateLimitRule, now: Date = new Date()): Promise<void> {
  assertRule(rule);
  await storeFor(db).refund(rule.key, now);
}

/**
 * Counts one attempt against every rule, in order, before the guarded check runs. When a rule is used up, the
 * attempts already counted for earlier rules are refunded and 429 `too_many_attempts` is thrown.
 */
export async function enforceAttempts(db: Db, rules: readonly RateLimitRule[], now: Date = new Date()): Promise<void> {
  const counted: RateLimitRule[] = [];
  for (const r of rules) {
    const result = await attempt(db, r, now);
    if (!result.allowed) {
      for (const earlier of counted) await refund(db, earlier, now);
      enforce(result);
    }
    counted.push(r);
  }
}

/**
 * Reads the bucket without counting. `allowed` is false when the limit is already used up.
 * For display only ("2 attempts left"); never gate a check with it (see the module comment).
 */
export async function peek(db: Db, rule: RateLimitRule, now: Date = new Date()): Promise<RateLimitResult> {
  assertRule(rule);
  const state = (await storeFor(db).get(rule.key, now)) ?? { count: 0, resetAt: new Date(now.getTime() + rule.windowSec * 1000) };
  return toResult(rule, state, now, state.count < rule.limit);
}

/** Forgets a bucket (successful sign-in clears the per-email attempts). */
export async function clear(db: Db, key: string): Promise<void> {
  await storeFor(db).delete(key);
}

/** Deletes expired buckets (cron housekeeping). */
export async function purgeExpired(db: Db, now: Date = new Date()): Promise<number> {
  return storeFor(db).purgeExpired(now);
}

/** Throws 429 `too_many_attempts` with Retry-After when the result is not allowed. */
export function enforce(result: RateLimitResult): void {
  if (!result.allowed) throw errors.rateLimited(result.retryAfterSec);
}

// ---------- Rules ----------

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 128-bit hashed identity so bucket keys never contain raw emails, IPs, user ids or key hashes. */
function hashedId(value: string): string {
  return sha256Hex(value).slice(0, 32);
}

const emailId = (email: string) => hashedId(email.trim().toLowerCase());
// IPv6 clients are bucketed per /64, the allocation a single subscriber controls.
const ipId = (ip: string | null | undefined) => hashedId(ipBucket(ip));

function rule(key: string, limit: number, windowSec: number): RateLimitRule {
  return { key, limit, windowSec };
}

/** Every rate limit in the app. Keys are namespaced "<flow>:<dimension>:<hashed id>". */
export const RATE_LIMITS = {
  /** Sign-in per email: 5 / 15 min (enforceAttempts before verifying, clear on success). */
  signInEmail: (email: string) => rule(`signin:email:${emailId(email)}`, 5, 15 * MINUTE),
  /** Sign-in per IP: 20 / 15 min (enforceAttempts before verifying, refund on success; never cleared). */
  signInIp: (ip: string | null | undefined) => rule(`signin:ip:${ipId(ip)}`, 20, 15 * MINUTE),
  register: (ip: string | null | undefined) => rule(`register:ip:${ipId(ip)}`, 5, HOUR),
  resendCode: (userId: string) => rule(`resend:user:${hashedId(userId)}`, 3, 15 * MINUTE),
  /**
   * Email verification guesses per user: 10 / 24 h across all codes (attempt before checking, clear on success). Each
   * code also allows only 5 guesses, but resends hand out fresh codes, so without this cap a squatter could guess a
   * 6-digit code over days and claim that address's guest orders.
   */
  verifyEmailUser: (userId: string) => rule(`verify:user:${hashedId(userId)}`, 10, DAY),
  /** Email verification guesses per IP: 30 / 15 min (attempt before checking, refund on success). */
  verifyEmailIp: (ip: string | null | undefined) => rule(`verify:ip:${ipId(ip)}`, 30, 15 * MINUTE),
  forgotEmail: (email: string) => rule(`forgot:email:${emailId(email)}`, 3, HOUR),
  forgotIp: (ip: string | null | undefined) => rule(`forgot:ip:${ipId(ip)}`, 10, HOUR),
  resetIp: (ip: string | null | undefined) => rule(`reset:ip:${ipId(ip)}`, 10, HOUR),
  /** Key reveal password checks: 5 / 15 min per user (attempt before verifying, clear on success). */
  keyReveal: (userId: string) => rule(`reveal:user:${hashedId(userId)}`, 5, 15 * MINUTE),
  activateKey: (keyHash: string) => rule(`activate:key:${hashedId(keyHash)}`, 10, MINUTE),
  activateIp: (ip: string | null | undefined) => rule(`activate:ip:${ipId(ip)}`, 60, MINUTE),
  validateLicense: (licenseId: string) => rule(`validate:license:${hashedId(licenseId)}`, 30, MINUTE),
  /** Device API /validate per client IP: 60 / min (counted before the token signature check). */
  validateIp: (ip: string | null | undefined) => rule(`validate:ip:${ipId(ip)}`, 60, MINUTE),
  /** Device API /deactivate per license: 30 / min (counted once the activation token is verified). */
  deactivateLicense: (licenseId: string) => rule(`deactivate:license:${hashedId(licenseId)}`, 30, MINUTE),
  /** Device API /deactivate per client IP: 60 / min (counted before the token signature check). */
  deactivateIp: (ip: string | null | undefined) => rule(`deactivate:ip:${ipId(ip)}`, 60, MINUTE),
  couponIp: (ip: string | null | undefined) => rule(`coupon:ip:${ipId(ip)}`, 20, 10 * MINUTE),
  contactIp: (ip: string | null | undefined) => rule(`contact:ip:${ipId(ip)}`, 5, HOUR),
  downloads: (userId: string) => rule(`download:user:${hashedId(userId)}`, 30, HOUR),
  /** "Change password" current-password checks: 5 / 15 min per user (attempt before verifying, clear on success). */
  changePassword: (userId: string) => rule(`pwchange:user:${hashedId(userId)}`, 5, 15 * MINUTE),
  /** Two-step code checks per IP: 30 / 15 min (each challenge also allows only 5 guesses). */
  loginCodeIp: (ip: string | null | undefined) => rule(`otp:ip:${ipId(ip)}`, 30, 15 * MINUTE),
  /** Order creation and payment retries (each creates a provider order): 20 / hour per IP. */
  orderIp: (ip: string | null | undefined) => rule(`checkout-order:ip:${ipId(ip)}`, 20, HOUR),
  /** Quotes without a coupon code (checkout re-quotes on every state change): 120 / 10 min per IP. Coupon quotes use couponIp. */
  quoteIp: (ip: string | null | undefined) => rule(`checkout-quote:ip:${ipId(ip)}`, 120, 10 * MINUTE),
  /** Payment return signature checks: 30 / 10 min per IP (attempt before verifying, refund on success). */
  orderReturnIp: (ip: string | null | undefined) => rule(`checkout-return:ip:${ipId(ip)}`, 30, 10 * MINUTE),
  /** Order status reads (the order page polls every 2 s for up to 2 minutes): 300 / 5 min per IP. */
  orderStatusIp: (ip: string | null | undefined) => rule(`order-status:ip:${ipId(ip)}`, 300, 5 * MINUTE),
  /** Order cancel requests: 30 / 10 min per IP. */
  orderActionIp: (ip: string | null | undefined) => rule(`order-action:ip:${ipId(ip)}`, 30, 10 * MINUTE),
  /** Tax invoice PDF renders (CPU work): 30 / 10 min per IP. */
  invoicePdfIp: (ip: string | null | undefined) => rule(`invoice-pdf:ip:${ipId(ip)}`, 30, 10 * MINUTE),
  /**
   * Webhook deliveries with a bad signature that are RECORDED (WebhookDelivery): 30 / 10 min per IP. Over the limit
   * they still get 401 but are not stored. Valid deliveries are never limited.
   */
  webhookInvalidIp: (ip: string | null | undefined) => rule(`webhook:invalid:ip:${ipId(ip)}`, 30, 10 * MINUTE),
  // ---- Customer portal (Phase 4 device actions, Phase 5). Keys unchanged from when they lived next to their routes. ----
  /** Device rename / move / deactivate requests: 60 / 10 min per user (the yearly self-service counter is the business limit). */
  accountDevices: (userId: string) => rule(`account-devices:user:${hashedId(userId)}`, 60, 10 * MINUTE),
  /** Accountant CSV exports (each reads up to 10,000 orders): 20 / 10 min per user. */
  ordersExport: (userId: string) => rule(`orders-export:user:${hashedId(userId)}`, 20, 10 * MINUTE),
  /** Billing detail saves: 30 / 10 min per user. */
  billingUpdate: (userId: string) => rule(`billing-update:user:${hashedId(userId)}`, 30, 10 * MINUTE),
  /** Location adds, renames and deletes: 60 / 10 min per user. */
  accountLocations: (userId: string) => rule(`account-locations:user:${hashedId(userId)}`, 60, 10 * MINUTE),
  /** Portal trial starts: 10 / hour per user (one trial per product per account anyway). */
  trialStart: (userId: string) => rule(`trials:user:${hashedId(userId)}`, 10, HOUR),
  /** Portal search (debounced as the user types): 120 / min per user. */
  accountSearch: (userId: string) => rule(`account-search:user:${hashedId(userId)}`, 120, MINUTE),
  /** Mark-read and email-preference writes: 120 / 10 min per user. */
  notificationWrites: (userId: string) => rule(`notifications-write:user:${hashedId(userId)}`, 120, 10 * MINUTE),
  /** Account data exports (each reads the whole account): 5 / hour per user. */
  accountExport: (userId: string) => rule(`account-export:user:${hashedId(userId)}`, 5, HOUR),
  /** Password checks when turning two-step off: 5 / 15 min per user (attempt before verifying, clear on success). */
  twoStepOff: (userId: string) => rule(`twostep-off:user:${hashedId(userId)}`, 5, 15 * MINUTE),
  /** Two-step changes (each writes an activity row): 20 / hour per user. */
  twoStepToggle: (userId: string) => rule(`twostep:user:${hashedId(userId)}`, 20, HOUR),
  /** Profile saves: 30 / 10 min per user. */
  profileUpdate: (userId: string) => rule(`profile:user:${hashedId(userId)}`, 30, 10 * MINUTE),
  /** New support tickets: 10 / hour per user. */
  ticketCreate: (userId: string) => rule(`ticket-create:user:${hashedId(userId)}`, 10, HOUR),
  /** Ticket replies and resolve / reopen: 60 / hour per user. */
  ticketUpdate: (userId: string) => rule(`ticket-update:user:${hashedId(userId)}`, 60, HOUR),
  /** Presigned attachment uploads: 30 / hour per user. */
  uploadCreate: (userId: string) => rule(`upload:user:${hashedId(userId)}`, 30, HOUR),
  /** Upload confirmations (a storage HEAD each): 60 / hour per user. */
  uploadConfirm: (userId: string) => rule(`upload-confirm:user:${hashedId(userId)}`, 60, HOUR),
  /** Attachment download links: 120 / hour per user. */
  attachmentDownload: (userId: string) => rule(`attachment-download:user:${hashedId(userId)}`, 120, HOUR),
  /** Team invitations sent by one owner: 20 / hour. */
  teamInviteUser: (userId: string) => rule(`team-invite:user:${hashedId(userId)}`, 20, HOUR),
  /** Team invitations for one account (emails go to arbitrary addresses): 50 / day. */
  teamInviteAccount: (accountId: string) => rule(`team-invite:account:${hashedId(accountId)}`, 50, DAY),
  /** Resends for one pending member of an account: 3 / hour. */
  teamInviteResend: (accountId: string, memberId: string) => rule(`team-invite-resend:member:${hashedId(`${accountId}:${memberId}`)}`, 3, HOUR),
  /** Invitation previews (GET /api/invites/:token and the /invite page): 60 / 10 min per IP. */
  invitePreviewIp: (ip: string | null | undefined) => rule(`invite-preview:ip:${ipId(ip)}`, 60, 10 * MINUTE),
  /** Invitation acceptances (a password hash each): 20 / 15 min per IP. */
  inviteAcceptIp: (ip: string | null | undefined) => rule(`invite-accept:ip:${ipId(ip)}`, 20, 15 * MINUTE),
  /** Team role changes and removals: 60 / 10 min per owner. */
  teamChange: (userId: string) => rule(`team-change:user:${hashedId(userId)}`, 60, 10 * MINUTE),
  /** Activity log CSV exports: 10 / 10 min per user. */
  activityExport: (userId: string) => rule(`activity-export:user:${hashedId(userId)}`, 10, 10 * MINUTE),
  // ---- Admin console (Phase 6) ----
  /** Admin CSV exports (each up to 10,000 rows; lib/admin/export.ts): 60 / 10 min per staff member. */
  adminExport: (staffId: string) => rule(`admin-export:user:${hashedId(staffId)}`, 60, 10 * MINUTE),
  /**
   * Password re-entry for saving, clearing or removing integration settings (Admin > Settings > Integrations): 5 / 15 min
   * per Owner (attempt before verifying, clear on success, like keyReveal).
   */
  integrationPassword: (userId: string) => rule(`integration-password:user:${hashedId(userId)}`, 5, 15 * MINUTE),
  /** Integration test buttons (each reaches Razorpay, the SMTP server or the bucket): 10 / 10 min per Owner; never cleared. */
  integrationTest: (userId: string) => rule(`integration-test:user:${hashedId(userId)}`, 10, 10 * MINUTE),
} as const;
