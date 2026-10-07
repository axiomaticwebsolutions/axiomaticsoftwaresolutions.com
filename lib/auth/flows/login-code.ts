/**
 * Two-step sign-in with an emailed 6-digit code (docs/decisions.md 12 and Phase 3 "Auth"): AuthToken LOGIN_OTP,
 * 10 minutes, 5 guesses, only the latest challenge per user works.
 *
 * The challenge id returned to the browser is "<token id>.<256-bit secret>"; only the secret's SHA-256 is stored
 * (meta.challenge), so the code alone (e.g. read from a forwarded email) is useless without the browser that
 * passed the password step. The code is stored as an HMAC (lib/auth/flows/common.ts).
 * Success completes the sign-in (completeSignIn) and, when asked, returns a trusted-device cookie value.
 */
import "server-only";
import type { Prisma, User } from "@/generated/prisma/client";
import {
  AUTH_MESSAGES,
  LOGIN_CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  canSignIn,
  codeExpiredError,
  codeMatches,
  emailHint,
  hashCode,
  invalidCodeError,
  invalidateUserTokens,
  metaString,
  newOpaqueSecret,
  nowOf,
  secretMatches,
  splitOpaqueToken,
  type AuthRequestContext,
} from "@/lib/auth/flows/common";
import { completeSignIn, type SignedIn } from "@/lib/auth/flows/complete-sign-in";
import { attempt, peek, RATE_LIMITS, refund } from "@/lib/auth/rate-limit";
import { safeNext } from "@/lib/auth/redirect";
import { randomSixDigitCode } from "@/lib/auth/tokens";
import { issueTrustedDevice } from "@/lib/auth/trusted-device";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import { sendAuthEmail } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import type { SignInVerifyInput } from "@/lib/validation/auth";

export type LoginChallenge = { requires2fa: true; challengeId: string; emailHint: string };

/** Creates the challenge and emails the code. */
export async function createLoginChallenge(user: User, opts: { next?: string | null; now: Date }): Promise<LoginChallenge> {
  const code = randomSixDigitCode();
  const challenge = newOpaqueSecret();
  const next = safeNext(opts.next);
  const row = await db.$transaction(async (tx) => {
    await invalidateUserTokens(tx, user.id, ["LOGIN_OTP"], opts.now);
    return tx.authToken.create({
      data: {
        type: "LOGIN_OTP",
        userId: user.id,
        email: user.email,
        codeHash: hashCode("login_otp", user.id, user.email, code),
        expiresAt: new Date(opts.now.getTime() + LOGIN_CODE_TTL_MS),
        meta: { challenge: challenge.hash, ...(next ? { next } : {}) } satisfies Prisma.InputJsonValue,
      },
      select: { id: true },
    });
  });
  const { ok } = await sendAuthEmail({ to: user.email, templateId: "login_code", vars: { customer_name: greetingName(user.name), code } });
  if (!ok) log.warn("login_code_email_not_sent", { userId: user.id });
  log.info("sign_in_challenge", { userId: user.id });
  return { requires2fa: true, challengeId: `${row.id}.${challenge.secret}`, emailHint: emailHint(user.email) };
}

export type LoginCodeResult = SignedIn & { trustedDevice: { value: string; expiresAt: Date } | null };

const expired = () => codeExpiredError(AUTH_MESSAGES.loginCodeExpired);

/**
 * Checks the code. 410 `code_expired` (unknown, used or expired challenge), 429 `too_many_attempts` (5 wrong guesses
 * used this challenge up, or the per-IP limit), 422 `invalid_code`. Deactivated staff get 401 `invalid_credentials`.
 */
export async function verifyLoginCode(
  input: SignInVerifyInput,
  ctx: AuthRequestContext & { currentSessionId?: string | null },
): Promise<LoginCodeResult> {
  const now = nowOf(ctx);
  const ipRule = RATE_LIMITS.loginCodeIp(ctx.ip);
  const perIp = await attempt(db, ipRule, now);
  if (!perIp.allowed) throw errors.rateLimited(perIp.retryAfterSec);

  const parts = splitOpaqueToken(input.challengeId);
  if (!parts) throw expired();
  const token = await db.authToken.findUnique({ where: { id: parts.id }, include: { user: true } });
  if (!token || token.type !== "LOGIN_OTP" || !token.user || !secretMatches(parts.secret, metaString(token.meta, "challenge"))) {
    throw expired();
  }
  if (token.usedAt || token.expiresAt.getTime() <= now.getTime() || token.email !== token.user.email) throw expired();

  const counted = await db.authToken.updateMany({
    where: { id: token.id, usedAt: null, attempts: { lt: MAX_CODE_ATTEMPTS }, expiresAt: { gt: now } },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count === 0) {
    const signInState = await peek(db, RATE_LIMITS.signInEmail(token.user.email), now);
    throw errors.rateLimited(signInState.allowed ? 1 : signInState.retryAfterSec, AUTH_MESSAGES.loginCodeAttemptsUsed);
  }
  if (!codeMatches(token.codeHash, "login_otp", token.user.id, token.user.email, input.code)) throw invalidCodeError();

  const used = await db.authToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: now } });
  if (used.count === 0) throw expired();
  await refund(db, ipRule, now);

  // Re-read the user: staff may have been deactivated since the password step. (A password change or reset marks
  // every open challenge used, so a stale challenge never gets this far.)
  const user = await db.user.findUnique({ where: { id: token.user.id } });
  if (!user || !canSignIn(user)) {
    throw new ApiError(401, "invalid_credentials", AUTH_MESSAGES.invalidCredentials);
  }

  const signedIn = await completeSignIn(user, { next: metaString(token.meta, "next"), twoStep: true, now, ctx });
  const trustedDevice = input.trustDevice
    ? issueTrustedDevice(
        { userId: user.id, passwordHash: user.passwordHash, securityEpoch: user.securityEpoch, secret: getEnv().SESSION_SECRET },
        now,
      )
    : null;
  return { ...signedIn, trustedDevice };
}
