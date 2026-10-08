/**
 * Admin customer actions (customers.manage; prototype drawer "Resend verification" and "Send password reset", plus
 * "Create set-password link" from docs/admin-records-design.md A4), through the auth flows' own code and link handling:
 * - resend verification: a new 6-digit code (supersedes older ones) emailed with the email_verification template;
 * - password reset: a new 30-minute single-use link (older open links stop working) emailed with password_reset.
 * Both target the account's first active Owner unless `userId` names another member, share the customer-facing
 * per-person limits (RATE_LIMITS.resendCode / forgotEmail; a refused attempt is not counted) and write one audit row
 * in the transaction that stores the code or link hash. Codes and links are emailed directly (never stored, logged or
 * returned to staff). Both refuse people without a password (409 `no_password`): an active member without one gets a
 * set-password link instead.
 * - set-password link: for an active customer member WITHOUT a password (typically one staff created): a single-use
 *   7-day link, returned ONCE to the staff member (201) and emailed directly with set_password. Reason required
 *   (DESTRUCTIVE_ACTIONS "customers.set_password_link"), 5 links an hour per customer, older open links voided, one
 *   audit row (never the link).
 */
import "server-only";
import type { PrismaClient, StaffRole, User } from "@/generated/prisma/client";
import { runDestructive, validateDestructive, type DestructiveInput } from "@/lib/admin/destructive";
import { audit, type AuditActor } from "@/lib/audit";
import { newOpaqueSecret, RESET_TOKEN_TTL_MS, SET_PASSWORD_TTL_MS } from "@/lib/auth/flows/common";
import { resetUrl } from "@/lib/auth/flows/forgot-password";
import { issueEmailVerificationCode, sendVerificationEmail } from "@/lib/auth/flows/verify-email";
import { attempt, enforce, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { formatDateIST } from "@/lib/dates";
import { db as defaultDb } from "@/lib/db";
import { sendAuthEmail } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { errors } from "@/lib/http";
import { log } from "@/lib/log";
import { CUSTOMER_RECORD_MESSAGES, setPasswordExpiresText } from "./model";
import { findCustomerMember, issueSetPasswordToken, notCustomerError, sendSetPasswordEmail } from "./records";

export const CUSTOMER_ACTION_MESSAGES = {
  noOwner: CUSTOMER_RECORD_MESSAGES.noOwner,
  notMember: CUSTOMER_RECORD_MESSAGES.notMember,
  alreadyVerified: "This email address is already verified.",
  noPassword: "This person hasn’t set a password yet, so there’s nothing to verify or reset.",
  useSetPasswordLink: "This person hasn’t set a password yet. Create a set-password link instead.",
} as const;

export type CustomerActionContext = { actor: AuditActor; now?: Date; client?: PrismaClient };

export type CustomerEmailResult = { userId: string; email: string; sent: boolean };

type Target = { user: User; legalName: string };

/**
 * The member an action targets: `userId` when given (must belong to the account), else the first active Owner.
 * People without a password get 409 `no_password`: an invited placeholder with the old message, an active customer
 * member (e.g. one staff created) with a pointer to the set-password link.
 */
async function targetMember(client: PrismaClient, accountId: string, userId: string | undefined): Promise<Target> {
  const { user, status, legalName } = await findCustomerMember(client, accountId, userId);
  if (user.kind !== "CUSTOMER" || !user.passwordHash) {
    const message =
      status === "ACTIVE" && user.kind === "CUSTOMER" ? CUSTOMER_ACTION_MESSAGES.useSetPasswordLink : CUSTOMER_ACTION_MESSAGES.noPassword;
    throw errors.conflict("no_password", message);
  }
  return { user, legalName };
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

export type SetPasswordLinkResult = { userId: string; email: string; url: string; expiresAt: string; emailSent: boolean };

/**
 * POST /api/admin/customers/:id/set-password-link. Reason first (422), then 404 / 409 `no_owner` / 422 `userId` /
 * 409 `member_invited` / 409 `not_customer` / 409 `has_password`, then 429 after 5 links an hour for the person.
 */
export async function createSetPasswordLink(
  accountId: string,
  userId: string | undefined,
  ctx: CustomerActionContext & { staff: { id: string; role: StaffRole }; input: DestructiveInput },
): Promise<SetPasswordLinkResult> {
  const client = ctx.client ?? defaultDb;
  const now = ctx.now ?? new Date();
  validateDestructive("customers.set_password_link", { staff: ctx.staff, input: ctx.input, confirmValue: accountId });
  const target = await findCustomerMember(client, accountId, userId);
  if (target.status !== "ACTIVE") throw errors.conflict("member_invited", CUSTOMER_RECORD_MESSAGES.memberInvitedLink);
  if (target.user.kind !== "CUSTOMER") throw notCustomerError();
  if (target.user.passwordHash !== null) throw errors.conflict("has_password", CUSTOMER_RECORD_MESSAGES.hasPassword);
  enforce(await attempt(client, RATE_LIMITS.adminSetPasswordLink(target.user.id), now));

  const { secret, hash } = newOpaqueSecret();
  const expiresAt = new Date(now.getTime() + SET_PASSWORD_TTL_MS);
  const issued = await runDestructive(
    "customers.set_password_link",
    {
      staff: ctx.staff,
      actor: ctx.actor,
      input: ctx.input,
      targetId: accountId,
      target: target.user.email,
      targetType: "customer",
      detail: `${target.legalName} · expires ${formatDateIST(expiresAt)}`,
      client,
    },
    async (tx) => {
      // The person may have set a password (or changed email) since the checks above.
      const fresh = await tx.user.findUnique({ where: { id: target.user.id }, select: { email: true, passwordHash: true } });
      if (!fresh || fresh.email !== target.user.email) throw errors.conflict("customer_changed", "This customer just changed. Reload and try again.");
      if (fresh.passwordHash !== null) throw errors.conflict("has_password", CUSTOMER_RECORD_MESSAGES.hasPassword);
      return issueSetPasswordToken(tx, { userId: target.user.id, email: fresh.email, hash, expiresAt, issuedById: ctx.staff.id, now });
    },
  );
  const url = resetUrl(`${issued}.${secret}`);
  const emailSent = await sendSetPasswordEmail({
    to: target.user.email,
    name: target.user.name,
    url,
    expiresIn: setPasswordExpiresText(SET_PASSWORD_TTL_MS),
    businessName: target.legalName,
  });
  log.info("admin_set_password_link_created", { userId: target.user.id, accountId, emailSent });
  return { userId: target.user.id, email: target.user.email, url, expiresAt: expiresAt.toISOString(), emailSent };
}
