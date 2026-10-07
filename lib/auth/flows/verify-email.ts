/**
 * Email verification with an emailed 6-digit code (15 minutes, 5 attempts; only the latest code works).
 * Wrong guesses are also capped across codes: 10 per user per 24 hours and 30 per IP per 15 minutes, because
 * verifying claims the address's guest orders and licenses (decision 1) and resends hand out fresh codes.
 * Verifying marks the email verified, claims guest orders in the same transaction and rotates the session
 * (a privilege change). Copy: Account.dc.html.
 */
import "server-only";
import type { Prisma, Session, User } from "@/generated/prisma/client";
import { claimGuestOrders } from "@/lib/auth/flows/claim-guest-orders";
import {
  AUTH_MESSAGES,
  EMAIL_CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  codeExpiredError,
  codeMatches,
  hashCode,
  invalidCodeError,
  invalidateUserTokens,
  metaString,
  nowOf,
  waitText,
  type AuthRequestContext,
} from "@/lib/auth/flows/common";
import { attempt, clear, peek, RATE_LIMITS, refund } from "@/lib/auth/rate-limit";
import { redirectAfterVerification, safeNext, STAFF_HOME } from "@/lib/auth/redirect";
import { randomSixDigitCode } from "@/lib/auth/tokens";
import { rotateSession } from "@/lib/auth/sessions";
import { db, type Db } from "@/lib/db";
import { errors, type ApiError } from "@/lib/http";
import { log } from "@/lib/log";
import { sendAuthEmail } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";

type CodeOwner = Pick<User, "id" | "email" | "name">;

/**
 * Supersedes any earlier code and stores a new one (hash only). Returns the plain code for the email.
 * Call inside the transaction that creates or updates the user.
 */
export async function issueEmailVerificationCode(
  client: Db,
  user: CodeOwner,
  opts: { next?: string | null; now: Date },
): Promise<string> {
  await invalidateUserTokens(client, user.id, ["EMAIL_VERIFY"], opts.now);
  const code = randomSixDigitCode();
  const next = safeNext(opts.next);
  await client.authToken.create({
    data: {
      type: "EMAIL_VERIFY",
      userId: user.id,
      email: user.email,
      codeHash: hashCode("email_verify", user.id, user.email, code),
      expiresAt: new Date(opts.now.getTime() + EMAIL_CODE_TTL_MS),
      meta: (next ? { next } : {}) satisfies Prisma.InputJsonValue,
    },
  });
  return code;
}

/** Emails the code (after commit). Never throws; the user can ask for another code. */
export async function sendVerificationEmail(user: CodeOwner, code: string): Promise<boolean> {
  const { ok } = await sendAuthEmail({
    to: user.email,
    templateId: "email_verification",
    vars: { customer_name: greetingName(user.name), code },
  });
  if (!ok) log.warn("verification_email_not_sent", { userId: user.id });
  return ok;
}

export type VerifyEmailResult = {
  verified: true;
  alreadyVerified: boolean;
  claimedOrders: number;
  claimedLicenses: number;
  redirectTo: string;
  /** The rotated session (null when the email was already verified and nothing changed). */
  session: { token: string; session: Session } | null;
};

/** Staff go back to the console; customers continue to a safe `next` or the portal. */
function destination(user: Pick<User, "kind">, next: string | null | undefined): string {
  return user.kind === "STAFF" ? STAFF_HOME : redirectAfterVerification(next);
}

/** Seconds until the user may request a new code (1 when they can right away). */
async function resendRetryAfter(userId: string, now: Date): Promise<number> {
  const state = await peek(db, RATE_LIMITS.resendCode(userId), now);
  return state.allowed ? 1 : state.retryAfterSec;
}

/** 429 once the per-user (10 / 24 h) or per-IP (30 / 15 min) guess cap is used up: a new code would not help. */
function guessesLockedError(retryAfterSec: number): ApiError {
  return errors.rateLimited(retryAfterSec, `Too many attempts. Try again in ${waitText(retryAfterSec)}.`);
}

/**
 * Checks the code for the signed-in user. 410 `code_expired` (no live code), 429 `too_many_attempts` (5 wrong
 * guesses used this code up, Retry-After = when a new code can be requested; or the per-user / per-IP guess cap
 * across codes is used up), 422 `invalid_code`.
 */
export async function verifyEmailCode(
  auth: { user: User; session: Session },
  input: { code: string; next?: string | null },
  ctx: AuthRequestContext,
): Promise<VerifyEmailResult> {
  const now = nowOf(ctx);
  const { user } = auth;
  if (user.emailVerifiedAt) {
    return {
      verified: true,
      alreadyVerified: true,
      claimedOrders: 0,
      claimedLicenses: 0,
      redirectTo: destination(user, input.next),
      session: null,
    };
  }

  const token = await db.authToken.findFirst({
    where: { userId: user.id, type: "EMAIL_VERIFY", usedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  if (!token || token.email !== user.email || token.expiresAt.getTime() <= now.getTime()) throw codeExpiredError();

  // Caps across codes (resends hand out fresh codes), counted before the guess is checked; only failures stay counted.
  const userRule = RATE_LIMITS.verifyEmailUser(user.id);
  const ipRule = RATE_LIMITS.verifyEmailIp(ctx.ip);
  const perUser = await attempt(db, userRule, now);
  if (!perUser.allowed) throw guessesLockedError(perUser.retryAfterSec);
  const perIp = await attempt(db, ipRule, now);
  if (!perIp.allowed) {
    await refund(db, userRule, now);
    throw guessesLockedError(perIp.retryAfterSec);
  }

  // Count the guess against this code before checking it (atomic), so parallel guesses cannot exceed the limit.
  const counted = await db.authToken.updateMany({
    where: { id: token.id, usedAt: null, attempts: { lt: MAX_CODE_ATTEMPTS }, expiresAt: { gt: now } },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count === 0) {
    // No guess was checked, so it does not count against the caps.
    await refund(db, userRule, now);
    await refund(db, ipRule, now);
    throw errors.rateLimited(await resendRetryAfter(user.id, now), AUTH_MESSAGES.codeAttemptsUsed);
  }
  if (!codeMatches(token.codeHash, "email_verify", user.id, user.email, input.code)) throw invalidCodeError();

  const next = input.next ?? metaString(token.meta, "next");
  const result = await db.$transaction(async (tx) => {
    const used = await tx.authToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
    if (used.count === 0) throw codeExpiredError();
    await invalidateUserTokens(tx, user.id, ["EMAIL_VERIFY"], now);
    const verifiedUser = await tx.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: now, lastActiveAt: now },
    });
    const claim = await claimGuestOrders(tx, verifiedUser);
    const rotated = await rotateSession(tx, auth.session.id, {
      userId: user.id,
      kind: verifiedUser.kind,
      userAgent: ctx.userAgent,
      ip: ctx.ip,
      activeAccountId: claim.accountId ?? auth.session.activeAccountId,
      now,
    });
    return { claim, rotated };
  });
  await clear(db, userRule.key);
  await refund(db, ipRule, now);

  log.info("email_verified", {
    userId: user.id,
    claimedOrders: result.claim.orderIds,
    claimedLicenses: result.claim.licenseIds.length,
  });
  return {
    verified: true,
    alreadyVerified: false,
    claimedOrders: result.claim.orderIds.length,
    claimedLicenses: result.claim.licenseIds.length,
    redirectTo: destination(user, next),
    session: result.rotated,
  };
}
