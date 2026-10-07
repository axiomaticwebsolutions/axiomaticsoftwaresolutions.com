/**
 * "Reset your password": always answers the same (the route returns 200 {}), whether or not the address has an
 * account, so it cannot be used to discover accounts.
 *
 * - 10 / hour per IP (429 with Retry-After, independent of the address). 3 / hour per address: further requests are
 *   silently dropped (still 200), so nobody can flood an inbox.
 * - Eligible: users with a password who may sign in (customers; staff while ACTIVE). Invited staff use their
 *   invitation; sample users without a password stay locked.
 * - The link token is "<id>.<256-bit secret>" (SHA-256 stored), valid 30 minutes, single use. Issuing a new link
 *   supersedes older ones (in the same transaction). A throttled or ineligible request changes nothing: if it voided
 *   the live link, anyone could keep an account from being recovered by asking for links in its name.
 * - The email is sent without awaiting it, and every path runs a transaction of the same shape (the non-issuing one
 *   matches no rows), so response time does not reveal whether a mail went out.
 */
import "server-only";
import { canSignIn, newOpaqueSecret, nowOf, RESET_TOKEN_TTL_MS, type AuthRequestContext } from "@/lib/auth/flows/common";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/log";
import { sendAuthEmail } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import type { ForgotPasswordInput } from "@/lib/validation/auth";

export const RESET_PATH = "/reset";

export function resetUrl(token: string): string {
  return `${getEnv().APP_URL}${RESET_PATH}?token=${encodeURIComponent(token)}`;
}

/** Open reset links of this address (all of them, or none with `match: false`). */
function openLinks(email: string, match: boolean) {
  return { email, type: "PASSWORD_RESET" as const, usedAt: null, ...(match ? {} : { id: "" }) };
}

/** Returns whether a link was issued (for tests and logs only; never exposed to the client). */
export async function requestPasswordReset(input: ForgotPasswordInput, ctx: AuthRequestContext): Promise<{ issued: boolean }> {
  const now = nowOf(ctx);
  enforce(await hit(db, RATE_LIMITS.forgotIp(ctx.ip), now));
  const perEmail = await hit(db, RATE_LIMITS.forgotEmail(input.email), now);

  const user = await db.user.findUnique({ where: { email: input.email } });
  if (!perEmail.allowed || !user || !user.passwordHash || !canSignIn(user)) {
    // Same statements as issuing a link, matching nothing: the live link stays valid.
    await db.$transaction([
      db.authToken.updateMany({ where: openLinks(input.email, false), data: { usedAt: now } }),
      db.authToken.findFirst({ where: { id: "" }, select: { id: true } }),
    ]);
    if (!perEmail.allowed) log.info("password_reset_throttled", { userId: user?.id ?? null });
    return { issued: false };
  }

  const { secret, hash } = newOpaqueSecret();
  const [, row] = await db.$transaction([
    // Older links stop working once a new one is issued.
    db.authToken.updateMany({ where: openLinks(input.email, true), data: { usedAt: now } }),
    db.authToken.create({
      data: {
        type: "PASSWORD_RESET",
        userId: user.id,
        email: user.email,
        codeHash: hash,
        expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS),
      },
      select: { id: true },
    }),
  ]);
  const link = resetUrl(`${row.id}.${secret}`);
  // Not awaited: SMTP latency must not distinguish known from unknown addresses. sendAuthEmail never throws.
  void sendAuthEmail({
    to: user.email,
    templateId: "password_reset",
    vars: { customer_name: greetingName(user.name), reset_url: link },
  }).then(({ ok }) => {
    if (!ok) log.warn("password_reset_email_not_sent", { userId: user.id });
  });
  log.info("password_reset_requested", { userId: user.id });
  return { issued: true };
}
