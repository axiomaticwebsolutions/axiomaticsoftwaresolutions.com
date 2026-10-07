/**
 * Password sign-in (api-contracts section 1; test-plan "Authentication").
 *
 * 1. The attempt is counted BEFORE the password is checked (per email 5 / 15 min, then per IP 20 / 15 min), so the
 *    6th attempt within the window is refused with 429 + Retry-After even when the password is right, and parallel
 *    guesses can never run more checks than the limit.
 * 2. Unknown email, wrong password, a user without a password, and staff who are invited or deactivated all get the
 *    same 401 `invalid_credentials` with the same message, after the same argon2id work (verifyAgainstDummy for
 *    unknown emails). The optional "{n} attempts left." suffix comes from the per-email counter, which exists for
 *    unknown emails too, so it reveals nothing.
 * 3. Two-step users without a valid trusted-device cookie get an emailed code instead of a session
 *    ({ requires2fa: true, challengeId, emailHint }). The per-email attempt stays counted until the code succeeds.
 * 4. Otherwise completeSignIn(): clear/refund the counters, claim guest orders, rotate the session.
 */
import "server-only";
import { canSignIn, invalidCredentialsError, nowOf, signInLockedError, type AuthRequestContext } from "@/lib/auth/flows/common";
import { completeSignIn, type SignedIn } from "@/lib/auth/flows/complete-sign-in";
import { createLoginChallenge, type LoginChallenge } from "@/lib/auth/flows/login-code";
import { hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from "@/lib/auth/password";
import { attempt, refund, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { verifyTrustedDevice } from "@/lib/auth/trusted-device";
import { requiresTwoStep } from "@/lib/rbac";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import type { SignInInput } from "@/lib/validation/auth";

export type SignInContext = AuthRequestContext & {
  currentSessionId?: string | null;
  /** Raw `axs_td` cookie value, if any. */
  trustedDevice?: string | null;
};

export type SignInResult = SignedIn | LoginChallenge;

export async function signIn(input: SignInInput, ctx: SignInContext): Promise<SignInResult> {
  const now = nowOf(ctx);
  const emailRule = RATE_LIMITS.signInEmail(input.email);
  const ipRule = RATE_LIMITS.signInIp(ctx.ip);

  const perEmail = await attempt(db, emailRule, now);
  if (!perEmail.allowed) throw signInLockedError(perEmail.retryAfterSec);
  const perIp = await attempt(db, ipRule, now);
  if (!perIp.allowed) {
    await refund(db, emailRule, now);
    throw signInLockedError(perIp.retryAfterSec);
  }

  const user = await db.user.findUnique({ where: { email: input.email } });
  const passwordOk = user ? await verifyPassword(input.password, user.passwordHash) : await verifyAgainstDummy(input.password);
  if (!user || !passwordOk || !canSignIn(user)) {
    log.info("sign_in_failed", { userId: user?.id ?? null, attemptsForEmail: perEmail.count });
    throw invalidCredentialsError(perEmail.count, perEmail.limit);
  }

  // Owner and Finance staff always confirm with a code (decisions.md Phase 6), even if the stored flag is off.
  if (user.twoStepEnabled || (user.kind === "STAFF" && requiresTwoStep(user.staffRole))) {
    const trusted = verifyTrustedDevice(
      ctx.trustedDevice,
      { userId: user.id, passwordHash: user.passwordHash, securityEpoch: user.securityEpoch, secret: getEnv().SESSION_SECRET },
      now,
    );
    if (!trusted) return createLoginChallenge(user, { next: input.next, now });
  }

  let signedInUser = user;
  if (user.passwordHash && needsRehash(user.passwordHash)) {
    // Parameters changed since this hash was made: upgrade it now that we know the password.
    try {
      const passwordHash = await hashPassword(input.password);
      const { count } = await db.user.updateMany({ where: { id: user.id, passwordHash: user.passwordHash }, data: { passwordHash } });
      if (count === 1) signedInUser = { ...user, passwordHash };
    } catch (error) {
      log.warn("password_rehash_failed", { userId: user.id, error });
    }
  }
  return completeSignIn(signedInUser, { next: input.next, twoStep: false, now, ctx });
}
