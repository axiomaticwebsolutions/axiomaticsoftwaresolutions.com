/**
 * The last step of every successful sign-in (password only, or password + two-step code):
 * forgets the per-email failure count and gives back the per-IP slot (lib/auth/rate-limit.ts), claims guest
 * orders for verified customers, and replaces any existing session with a fresh one (session rotation: a token
 * planted before authentication is never promoted).
 */
import "server-only";
import type { Session, User } from "@/generated/prisma/client";
import { claimGuestOrdersSafely } from "@/lib/auth/flows/claim-guest-orders";
import { ownerAccountId, type AuthRequestContext } from "@/lib/auth/flows/common";
import { clear, refund, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { redirectAfterSignIn } from "@/lib/auth/redirect";
import { rotateSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

export type SignedIn = {
  requires2fa: false;
  user: User;
  token: string;
  session: Session;
  redirectTo: string;
};

export async function completeSignIn(
  user: User,
  opts: { next?: string | null; twoStep: boolean; now: Date; ctx: AuthRequestContext & { currentSessionId?: string | null } },
): Promise<SignedIn> {
  const { now, ctx } = opts;
  await clear(db, RATE_LIMITS.signInEmail(user.email).key);
  await refund(db, RATE_LIMITS.signInIp(ctx.ip), now);

  let activeAccountId: string | null = null;
  if (user.kind === "CUSTOMER") {
    if (user.emailVerifiedAt) await claimGuestOrdersSafely(user);
    activeAccountId = await ownerAccountId(db, user.id);
  }

  const { token, session } = await rotateSession(db, ctx.currentSessionId, {
    userId: user.id,
    kind: user.kind,
    userAgent: ctx.userAgent,
    ip: ctx.ip,
    activeAccountId,
    now,
  });
  const updated = await db.user.update({ where: { id: user.id }, data: { lastActiveAt: now } });
  log.info("signed_in", { userId: user.id, kind: user.kind, twoStep: opts.twoStep, sessionId: session.id });
  return {
    requires2fa: false,
    user: updated,
    token,
    session,
    redirectTo: redirectAfterSignIn({ kind: user.kind, emailVerified: Boolean(user.emailVerifiedAt) }, opts.next),
  };
}
