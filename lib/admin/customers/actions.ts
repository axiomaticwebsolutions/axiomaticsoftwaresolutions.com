/**
 * Admin customer actions (customers.manage; prototype drawer "Resend verification" and "Send password reset"),
 * through the auth flows' own code and link handling:
 * - resend verification: a new 6-digit code (supersedes older ones) emailed with the email_verification template;
 * - password reset: a new 30-minute single-use link (older open links stop working) emailed with password_reset.
 * Both target the account's first active Owner unless `userId` names another member, share the customer-facing
 * per-person limits (RATE_LIMITS.resendCode / forgotEmail; a refused attempt is not counted) and write one audit row
 * in the transaction that stores the code or link hash. Codes and links are emailed directly (never stored, logged or
 * returned to staff).
 */
import "server-only";
import type { PrismaClient, User } from "@/generated/prisma/client";
import { audit, type AuditActor } from "@/lib/audit";
import { newOpaqueSecret, RESET_TOKEN_TTL_MS } from "@/lib/auth/flows/common";
import { resetUrl } from "@/lib/auth/flows/forgot-password";
import { issueEmailVerificationCode, sendVerificationEmail } from "@/lib/auth/flows/verify-email";
import { attempt, enforce, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db as defaultDb } from "@/lib/db";
import { sendAuthEmail } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { errors } from "@/lib/http";
import { log } from "@/lib/log";

export const CUSTOMER_ACTION_MESSAGES = {
  noOwner: "This account has no active owner. Choose a member instead.",
  notMember: "Choose a member of this account.",
  alreadyVerified: "This email address is already verified.",
  noPassword: "This person hasn\u2019t set a password yet, so there\u2019s nothing to verify or reset.",
} as const;

export type CustomerActionContext = { actor: AuditActor; now?: Date; client?: PrismaClient };

export type CustomerEmailResult = { userId: string; email: string; sent: boolean };

type Target = { user: User; legalName: string };

/** The member an action targets: `userId` when given (must belong to the account), else the first active Owner. */
async function targetMember(client: PrismaClient, accountId: string, userId: string | undefined): Promise<Target> {
  const account = await client.businessAccount.findUnique({ where: { id: accountId }, select: { legalName: true } });
  if (!account) throw errors.notFound("Customer");
  const member = await client.accountMember.findFirst({
    where: userId ? { accountId, userId } : { accountId, role: "OWNER", status: "ACTIVE" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { user: true },
  });
  if (!member) throw userId ? errors.validation({ userId: CUSTOMER_ACTION_MESSAGES.notMember }) : errors.conflict("no_owner", CUSTOMER_ACTION_MESSAGES.noOwner);
  if (member.user.kind !== "CUSTOMER" || !member.user.passwordHash) throw errors.conflict("no_password", CUSTOMER_ACTION_MESSAGES.noPassword);
  return { user: member.user, legalName: account.legalName };
}

/** Resend verification: 409 `already_verified` for verified addresses; 429 after 3 codes in 15 minutes per person. */
export async function resendCustomerVerification(
  accountId: string,
  userId: string | undefined,
  ctx: CustomerActionContext,
): Promise<CustomerEmailResult> {
  const client = ctx.client ?? defaultDb;
  const now = ctx.now ?? new Date();
  const { user, legalName } = await targetMember(client, accountId, userId);
  if (user.emailVerifiedAt) throw errors.conflict("already_verified", CUSTOMER_ACTION_MESSAGES.alreadyVerified);
  enforce(await attempt(client, RATE_LIMITS.resendCode(user.id), now));
  const code = await client.$transaction(async (tx) => {
    const issued = await issueEmailVerificationCode(tx, user, { next: null, now });
    await audit(tx, ctx.actor, {
      action: "Resent verification email",
      target: user.email,
      targetType: "customer",
      targetId: accountId,
      detail: legalName,
    });
    return issued;
  });
  const sent = await sendVerificationEmail(user, code);
  log.info("admin_verification_resent", { userId: user.id, accountId, sent });
  return { userId: user.id, email: user.email, sent };
}

/** Password reset link: older open links stop working; 429 after 3 links an hour per address. */
export async function sendCustomerPasswordReset(
  accountId: string,
  userId: string | undefined,
  ctx: CustomerActionContext,
): Promise<CustomerEmailResult> {
  const client = ctx.client ?? defaultDb;
  const now = ctx.now ?? new Date();
  const { user, legalName } = await targetMember(client, accountId, userId);
  enforce(await attempt(client, RATE_LIMITS.forgotEmail(user.email), now));
  const { secret, hash } = newOpaqueSecret();
  const tokenId = await client.$transaction(async (tx) => {
    await tx.authToken.updateMany({ where: { email: user.email, type: "PASSWORD_RESET", usedAt: null }, data: { usedAt: now } });
    const row = await tx.authToken.create({
      data: { type: "PASSWORD_RESET", userId: user.id, email: user.email, codeHash: hash, expiresAt: new Date(now.getTime() + RESET_TOKEN_TTL_MS) },
      select: { id: true },
    });
    await audit(tx, ctx.actor, {
      action: "Sent password reset",
      target: user.email,
      targetType: "customer",
      targetId: accountId,
      detail: legalName,
    });
    return row.id;
  });
  const { ok } = await sendAuthEmail({
    to: user.email,
    templateId: "password_reset",
    vars: { customer_name: greetingName(user.name), reset_url: resetUrl(`${tokenId}.${secret}`) },
  });
  log.info("admin_password_reset_sent", { userId: user.id, accountId, sent: ok });
  return { userId: user.id, email: user.email, sent: ok };
}
