/**
 * "Update password" (Security page): checks the current password (5 checks / 15 min per user, counted before
 * verifying), stores the new hash, signs out every OTHER session (the current one stays), voids open reset links
 * and two-step challenges, and logs "Changed password" / "Other sessions signed out" (security) for customers.
 * Trusted devices stop working: the security epoch is bumped (and their cookies are bound to the password hash too).
 */
import "server-only";
import type { Session, User } from "@/generated/prisma/client";
import { recordSecurityActivity } from "@/lib/auth/flows/activity";
import { AUTH_MESSAGES, invalidateUserTokens, nowOf } from "@/lib/auth/flows/common";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { attempt, clear, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { revokeAllSessions } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import type { ChangePasswordInput } from "@/lib/validation/auth";

export function incorrectCurrentPassword(): ApiError {
  return new ApiError(422, "incorrect_password", AUTH_MESSAGES.currentPasswordWrong, {
    details: { fieldErrors: { current: [AUTH_MESSAGES.currentPasswordWrong] }, formErrors: [] },
  });
}

export async function changePassword(
  auth: { user: User; session: Session },
  input: ChangePasswordInput,
  ctx: { now?: Date } = {},
): Promise<{ revokedSessions: number }> {
  const now = nowOf(ctx);
  const rule = RATE_LIMITS.changePassword(auth.user.id);
  const counted = await attempt(db, rule, now);
  if (!counted.allowed) throw errors.rateLimited(counted.retryAfterSec);

  // Re-read the hash: the session's copy of the user may be stale.
  const current = await db.user.findUnique({ where: { id: auth.user.id }, select: { passwordHash: true } });
  if (!(await verifyPassword(input.current, current?.passwordHash))) throw incorrectCurrentPassword();
  await clear(db, rule.key);

  const passwordHash = await hashPassword(input.next);
  const revokedSessions = await db.$transaction(async (tx) => {
    // A new security epoch invalidates every trusted-device cookie (lib/auth/trusted-device.ts).
    await tx.user.update({ where: { id: auth.user.id }, data: { passwordHash, securityEpoch: { increment: 1 } } });
    await invalidateUserTokens(tx, auth.user.id, ["PASSWORD_RESET", "LOGIN_OTP"], now);
    const revoked = await revokeAllSessions(tx, auth.user.id, { exceptSessionId: auth.session.id, now });
    await recordSecurityActivity(tx, auth, { action: "Changed password", target: "Other sessions signed out", now });
    return revoked;
  });
  log.info("password_changed", { userId: auth.user.id, revokedSessions });
  return { revokedSessions };
}
