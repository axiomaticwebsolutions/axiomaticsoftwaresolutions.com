/**
 * Registration (api-contracts section 1, docs/decisions.md Phase 3 "Auth"):
 * creates User (unverified) + BusinessAccount (legalName = business name, else the person's name) + OWNER
 * membership + a 6-digit verification code in one transaction, signs the user in with the OWNER account active,
 * then emails the code. Guest orders are NOT linked here; that happens on verification.
 * 409 `email_taken` uses the prototype copy (registration necessarily reveals that the address has an account).
 * An address with a pending team invitation only has a placeholder user (no password, unverified): registration
 * takes that row over (takeOverPlaceholderUser) instead of answering 409, and the invitation stays pending.
 */
import "server-only";
import type { BusinessAccount, Session, User } from "@/generated/prisma/client";
import {
  AUTH_MESSAGES,
  isPlaceholderUser,
  isUniqueViolation,
  nowOf,
  takeOverPlaceholderUser,
  type AuthRequestContext,
} from "@/lib/auth/flows/common";
import { issueEmailVerificationCode, sendVerificationEmail } from "@/lib/auth/flows/verify-email";
import { hashPassword } from "@/lib/auth/password";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { verifyPath } from "@/lib/auth/redirect";
import { rotateSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { log } from "@/lib/log";
import type { RegisterInput } from "@/lib/validation/auth";

export type RegisterResult = {
  user: User;
  account: BusinessAccount;
  token: string;
  session: Session;
  redirectTo: string;
};

const emailTaken = () => new ApiError(409, "email_taken", AUTH_MESSAGES.emailTaken);

export async function registerUser(
  input: RegisterInput,
  ctx: AuthRequestContext & { currentSessionId?: string | null },
): Promise<RegisterResult> {
  const now = nowOf(ctx);
  enforce(await hit(db, RATE_LIMITS.register(ctx.ip), now));

  // Cheap check first so a taken address does not cost an argon2 hash; the unique index decides races.
  const existing = await db.user.findUnique({
    where: { email: input.email },
    select: { kind: true, passwordHash: true, emailVerifiedAt: true },
  });
  if (existing && !isPlaceholderUser(existing)) throw emailTaken();

  const passwordHash = await hashPassword(input.password);
  let created: { user: User; account: BusinessAccount; code: string; token: string; session: Session };
  try {
    created = await db.$transaction(async (tx) => {
      const user =
        (await takeOverPlaceholderUser(tx, { email: input.email, name: input.name, passwordHash, now })) ??
        (await tx.user.create({
          data: { kind: "CUSTOMER", email: input.email, name: input.name, passwordHash, lastActiveAt: now },
        }));
      const account = await tx.businessAccount.create({ data: { legalName: input.businessName ?? input.name } });
      await tx.accountMember.create({ data: { accountId: account.id, userId: user.id, role: "OWNER", status: "ACTIVE" } });
      const code = await issueEmailVerificationCode(tx, user, { next: input.next, now });
      const { token, session } = await rotateSession(tx, ctx.currentSessionId, {
        userId: user.id,
        kind: "CUSTOMER",
        userAgent: ctx.userAgent,
        ip: ctx.ip,
        activeAccountId: account.id,
        now,
      });
      return { user, account, code, token, session };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw emailTaken();
    throw error;
  }

  await sendVerificationEmail(created.user, created.code);
  log.info("user_registered", { userId: created.user.id, accountId: created.account.id });
  return {
    user: created.user,
    account: created.account,
    token: created.token,
    session: created.session,
    redirectTo: verifyPath(input.next),
  };
}
