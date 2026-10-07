/**
 * "Didn’t get it? Resend code": a new verification code for the signed-in, unverified user.
 * 3 per 15 minutes per user (RATE_LIMITS.resendCode, 429 with Retry-After). The new code supersedes the old one
 * and keeps the `next` destination chosen at registration. Already verified users get a no-op success.
 */
import "server-only";
import type { User } from "@/generated/prisma/client";
import { metaString, nowOf } from "@/lib/auth/flows/common";
import { issueEmailVerificationCode, sendVerificationEmail } from "@/lib/auth/flows/verify-email";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";

export async function resendVerificationCode(user: User, ctx: { now?: Date } = {}): Promise<{ sent: boolean }> {
  const now = nowOf(ctx);
  if (user.emailVerifiedAt) return { sent: false };
  enforce(await hit(db, RATE_LIMITS.resendCode(user.id), now));

  const code = await db.$transaction(async (tx) => {
    const previous = await tx.authToken.findFirst({
      where: { userId: user.id, type: "EMAIL_VERIFY" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { meta: true },
    });
    return issueEmailVerificationCode(tx, user, { next: metaString(previous?.meta, "next"), now });
  });
  const sent = await sendVerificationEmail(user, code);
  return { sent };
}
