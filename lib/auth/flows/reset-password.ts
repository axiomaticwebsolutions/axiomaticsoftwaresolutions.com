/**
 * "Choose a new password" from the emailed link: single use, 30 minutes. The same page completes a staff-issued
 * set-password link (meta.purpose "set_password", 7 days; docs/admin-records-design.md A2.2): the page reads "Set your
 * password" while the user has none, and such a link is refused once a password exists. Completing it does not verify
 * the email (a copied link proves only that someone has the link).
 * Success sets the new password, bumps the security epoch (so every trusted device needs a code again), revokes every
 * session, voids open reset links and two-step challenges, lifts the per-email sign-in lock and sends the user to sign
 * in again. 422 `token_invalid` (unknown, malformed or already used), 410 `token_expired`.
 */
import "server-only";
import type { AuthToken, User } from "@/generated/prisma/client";
import {
  AUTH_MESSAGES,
  invalidateUserTokens,
  metaString,
  nowOf,
  resetExpiredError,
  resetInvalidError,
  secretMatches,
  SET_PASSWORD_PURPOSE,
  splitOpaqueToken,
  type AuthRequestContext,
} from "@/lib/auth/flows/common";
import { hashPassword } from "@/lib/auth/password";
import { clear, enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { revokeAllSessions } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import type { ResetPasswordInput } from "@/lib/validation/auth";

export const RESET_DONE_REDIRECT = "/sign-in?reset=1";

/** Finds the reset token a link carries, or throws 422/410. Does not consume it. */
export async function findResetToken(raw: string, now: Date): Promise<AuthToken & { user: User }> {
  const parts = splitOpaqueToken(raw);
  if (!parts) throw resetInvalidError();
  const token = await db.authToken.findUnique({ where: { id: parts.id }, include: { user: true } });
  if (!token || token.type !== "PASSWORD_RESET" || !token.user || !secretMatches(parts.secret, token.codeHash)) {
    throw resetInvalidError();
  }
  if (token.usedAt) throw resetInvalidError(AUTH_MESSAGES.resetUsed);
  if (token.expiresAt.getTime() <= now.getTime()) throw resetExpiredError();
  if (token.email !== token.user.email) throw resetInvalidError();
  // Defence in depth: a set-password link is for an account without a password (a newer reset voids it anyway).
  if (metaString(token.meta, "purpose") === SET_PASSWORD_PURPOSE && token.user.passwordHash !== null) throw resetInvalidError();
  return { ...token, user: token.user };
}

/** "set": the account has no password yet (the page reads "Set your password"); "reset": it has one. */
export type ResetMode = "set" | "reset";

/**
 * For the reset page: which account the link is for ("For {email}. Other sessions will be signed out.") and whether
 * it sets a first password or replaces one. Read-only and not rate limited: the link secret has 256 bits, so there is
 * nothing to guess.
 */
export async function inspectResetToken(raw: string, ctx: { now?: Date } = {}): Promise<{ email: string; mode: ResetMode }> {
  const token = await findResetToken(raw, nowOf(ctx));
  return { email: token.user.email, mode: token.user.passwordHash === null ? "set" : "reset" };
}

export async function resetPassword(
  input: ResetPasswordInput,
  ctx: AuthRequestContext,
): Promise<{ redirectTo: string; userId: string; revokedSessions: number }> {
  const now = nowOf(ctx);
  enforce(await hit(db, RATE_LIMITS.resetIp(ctx.ip), now));
  const token = await findResetToken(input.token, now);
  const passwordHash = await hashPassword(input.password);

  const revokedSessions = await db.$transaction(async (tx) => {
    // Single use, decided atomically: only one request can flip usedAt.
    const consumed = await tx.authToken.updateMany({
      where: { id: token.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (consumed.count === 0) throw resetInvalidError(AUTH_MESSAGES.resetUsed);
    // A new security epoch invalidates every trusted-device cookie (lib/auth/trusted-device.ts).
    await tx.user.update({ where: { id: token.user.id }, data: { passwordHash, securityEpoch: { increment: 1 } } });
    await invalidateUserTokens(tx, token.user.id, ["PASSWORD_RESET", "LOGIN_OTP"], now);
    return revokeAllSessions(tx, token.user.id, { now });
  });

  // The lock message says "or reset your password", so a reset lifts it.
  await clear(db, RATE_LIMITS.signInEmail(token.user.email).key);
  log.info("password_reset", { userId: token.user.id, revokedSessions });
  return { redirectTo: RESET_DONE_REDIRECT, userId: token.user.id, revokedSessions };
}
