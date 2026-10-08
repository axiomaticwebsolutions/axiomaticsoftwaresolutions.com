/**
 * Admin customer records (docs/admin-records-design.md PART A; decisions.md "Admin records", 2026-10-08):
 *
 * - createCustomer (POST /api/admin/customers, customers.create): a CUSTOMER user WITHOUT a password, marked
 *   `createdByStaffId` (never a placeholder, so /register and checkout cannot take it over), a business account they
 *   OWN (invitedAt null, so guest orders claim into it), optionally a staff-verified email (customers.verify_email;
 *   guest orders of that address are claimed in the same transaction), and a single-use 7-day set-password link
 *   (a PASSWORD_RESET token with meta.purpose "set_password"). The link is returned once and emailed directly after
 *   the commit; it is never stored in plain text, logged or audited. A failed email never undoes the creation.
 * - updateCustomer (PATCH /api/admin/customers/:id, customers.edit): the owner's name, mobile and email, and the
 *   account's business details. An email change bumps the security epoch, signs the person out everywhere, voids open
 *   EMAIL_VERIFY / PASSWORD_RESET / LOGIN_OTP / TEAM_INVITE tokens, clears verification unless the editor ticks "verified"
 *   (customers.verify_email) and tells the OLD address through the outbox.
 * - markCustomerEmailVerified (POST /api/admin/customers/:id/verify-email, customers.verify_email): idempotent; voids
 *   open verification codes and claims guest orders exactly as code verification does.
 *
 * Every write needs a reason (4-500 characters, checked first) and writes one AuditLog row (field names only, never
 * tokens, links or full old addresses) in the transaction that makes the change. A no-op writes nothing.
 */
import "server-only";
import type { MemberStatus, PrismaClient, StaffRole, User } from "@/generated/prisma/client";
import { DESTRUCTIVE_AUDIT_ACTIONS, runDestructive, type DestructiveInput } from "@/lib/admin/destructive";
import { audit, requireReason, type AuditActor } from "@/lib/audit";
import { claimGuestOrders } from "@/lib/auth/flows/claim-guest-orders";
import {
  emailHint,
  invalidateUserTokens,
  isPlaceholderUser,
  isUniqueViolation,
  newOpaqueSecret,
  ownerAccountId,
  PLACEHOLDER_USER_WHERE,
  SET_PASSWORD_PURPOSE,
  SET_PASSWORD_TTL_MS,
} from "@/lib/auth/flows/common";
import { resetUrl } from "@/lib/auth/flows/forgot-password";
import { revokeAllSessions } from "@/lib/auth/sessions";
import { db as defaultDb, type Db, type Prisma, type Tx } from "@/lib/db";
import { sendAuthEmail } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { enqueueEmail, kickEmailDispatch } from "@/lib/email/outbox";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import { recordAccountActivity } from "@/lib/portal/activity";
import { BILLING_ACTIVITY_ACTION, billingActivityTarget, BILLING_DETAIL_KEYS, mergeBillingDetails } from "@/lib/portal/billing";
import { can, roleForbiddenMessage } from "@/lib/rbac";
import { billingDetailsIssue, type BillingDetails } from "@/lib/validation/portal";
import {
  CUSTOMER_RECORD_MESSAGES,
  STAFF_ACTIVITY_ACTOR,
  changedCustomerFields,
  createdCustomerFields,
  guestClaimNote,
  setPasswordExpiresText,
  type AdminCustomerDetail,
} from "./model";
import { getAdminCustomerDetail } from "./queries";
import type { CustomerCreateInput, CustomerPatchInput } from "./schemas";

export type CustomerRecordContext = {
  staff: { id: string; role: StaffRole };
  actor: AuditActor;
  now?: Date;
  client?: PrismaClient;
};

/** Ticking "verified" (create, or with a new email on edit) also needs customers.verify_email (403). */
export function assertMayVerify(role: StaffRole, emailVerified: boolean | undefined): void {
  if (emailVerified === true && !can(role, "customers.verify_email")) throw errors.forbidden(roleForbiddenMessage(role));
}

/** 409 `email_taken` on the email field; `accountId` (when known) lets the console offer "Open customer". */
export function emailTakenError(message: string, accountId?: string | null): ApiError {
  return new ApiError(409, "email_taken", message, {
    details: { fieldErrors: { email: [message] }, formErrors: [], ...(accountId ? { accountId } : {}) },
  });
}

export const notCustomerError = () => errors.conflict("not_customer", CUSTOMER_RECORD_MESSAGES.notCustomer);

// ---------- Target member ----------

export type CustomerMemberTarget = { user: User; status: MemberStatus; legalName: string };

/**
 * The member an action targets: `userId` when given (must belong to the account: 422 on `userId`), else the first
 * active Owner (409 `no_owner`). 404 for an unknown account.
 */
export async function findCustomerMember(client: Db, accountId: string, userId: string | undefined): Promise<CustomerMemberTarget> {
  const account = await client.businessAccount.findUnique({ where: { id: accountId }, select: { legalName: true } });
  if (!account) throw errors.notFound("Customer");
  const member = await client.accountMember.findFirst({
    where: userId ? { accountId, userId } : { accountId, role: "OWNER", status: "ACTIVE" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { status: true, user: true },
  });
  if (!member) {
    throw userId
      ? errors.validation({ userId: CUSTOMER_RECORD_MESSAGES.notMember })
      : errors.conflict("no_owner", CUSTOMER_RECORD_MESSAGES.noOwner);
  }
  return { user: member.user, status: member.status, legalName: account.legalName };
}

// ---------- A1. Mark email as verified ----------

export type MarkVerifiedResult = { userId: string; email: string; changed: boolean; claimedOrders: number };

/**
 * POST /api/admin/customers/:id/verify-email. Reason first (422), then 404 / 409 `no_owner` / 422 `userId` / 409
 * `member_invited` / 409 `not_customer`. Already verified: 200 `changed: false`, nothing written (no audit row).
 */
export async function markCustomerEmailVerified(
  accountId: string,
  userId: string | undefined,
  ctx: CustomerRecordContext & { input: DestructiveInput },
): Promise<MarkVerifiedResult> {
  const now = ctx.now ?? new Date();
  const result = await runDestructive(
    "customers.verify_email",
    {
      staff: ctx.staff,
      actor: ctx.actor,
      input: ctx.input,
      targetId: accountId,
      target: accountId,
      targetType: "customer",
      selfAudited: true,
      client: ctx.client,
    },
    async (tx, { reason, actor }) => {
      const { user, status, legalName } = await findCustomerMember(tx, accountId, userId);
      if (status !== "ACTIVE") throw errors.conflict("member_invited", CUSTOMER_RECORD_MESSAGES.memberInvited);
      if (user.kind !== "CUSTOMER") throw notCustomerError();
      const { count } = await tx.user.updateMany({ where: { id: user.id, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
      if (count === 0) return { userId: user.id, email: user.email, changed: false, claimedOrders: 0 };
      await invalidateUserTokens(tx, user.id, ["EMAIL_VERIFY"], now);
      const claim = await claimGuestOrders(tx, { ...user, emailVerifiedAt: now });
      const claimed = claim.orderIds.length;
      await audit(tx, actor, {
        action: DESTRUCTIVE_AUDIT_ACTIONS["customers.verify_email"],
        target: user.email,
        targetType: "customer",
        targetId: accountId,
        reason,
        detail: `${legalName}${guestClaimNote(claim.orderIds)}`,
      });
      return { userId: user.id, email: user.email, changed: true, claimedOrders: claimed };
    },
  );
  if (result.changed) log.info("admin_customer_email_verified", { userId: result.userId, accountId, claimedOrders: result.claimedOrders });
  return result;
}

// ---------- Set-password links (shared by create and the set-password-link action) ----------

/**
 * Voids open reset links of `email` and stores a new set-password link (SHA-256 of a 256-bit secret, single use,
 * bound to the address). Returns the token id; the caller builds the URL from it and the secret after the commit.
 */
export async function issueSetPasswordToken(
  tx: Tx,
  input: { userId: string; email: string; hash: string; expiresAt: Date; issuedById: string | null; now: Date },
): Promise<string> {
  await tx.authToken.updateMany({ where: { email: input.email, type: "PASSWORD_RESET", usedAt: null }, data: { usedAt: input.now } });
  const meta: Prisma.InputJsonValue = input.issuedById
    ? { purpose: SET_PASSWORD_PURPOSE, issuedById: input.issuedById }
    : { purpose: SET_PASSWORD_PURPOSE };
  const row = await tx.authToken.create({
    data: { type: "PASSWORD_RESET", userId: input.userId, email: input.email, codeHash: input.hash, expiresAt: input.expiresAt, meta },
    select: { id: true },
  });
  return row.id;
}

/** Emails a staff-issued set-password link (after the commit). Never throws; false when it could not be sent. */
export async function sendSetPasswordEmail(input: { to: string; name: string; url: string; expiresIn: string; businessName?: string | null }): Promise<boolean> {
  const { ok } = await sendAuthEmail({
    to: input.to,
    templateId: "set_password",
    vars: {
      customer_name: greetingName(input.name),
      set_password_url: input.url,
      expires_in: input.expiresIn,
      ...(input.businessName ? { business_name: input.businessName } : {}),
    },
  });
  return ok;
}

// ---------- A2. Create customer ----------

export type CreateCustomerResult = {
  accountId: string;
  userId: string;
  email: string;
  emailVerified: boolean;
  claimedOrders: number;
  /** The one-time set-password link (shown once in the console; never stored, logged or audited). */
  setPassword: { url: string; expiresAt: string };
  emailSent: boolean;
};

/**
 * POST /api/admin/customers. 422 reason, 403 for "verified" without customers.verify_email, 409 `email_taken`
 * (staff address; an existing customer, with `accountId` of the account they own). A team-invite placeholder of the
 * address is taken over (its pending invitations stay).
 */
export async function createCustomer(input: CustomerCreateInput, ctx: CustomerRecordContext): Promise<CreateCustomerResult> {
  const client = ctx.client ?? defaultDb;
  const now = ctx.now ?? new Date();
  const reason = requireReason(input.reason);
  assertMayVerify(ctx.staff.role, input.emailVerified);
  const email = input.email;
  const verified = input.emailVerified === true;
  const legalName = input.legalName ?? input.name;

  const existing = await client.user.findUnique({
    where: { email },
    select: { id: true, kind: true, passwordHash: true, emailVerifiedAt: true, createdByStaffId: true },
  });
  if (existing?.kind === "STAFF") throw emailTakenError(CUSTOMER_RECORD_MESSAGES.emailTakenStaff);
  if (existing && !isPlaceholderUser(existing)) {
    throw emailTakenError(CUSTOMER_RECORD_MESSAGES.emailTakenCustomer, await ownerAccountId(client, existing.id));
  }

  const { secret, hash } = newOpaqueSecret();
  const expiresAt = new Date(now.getTime() + SET_PASSWORD_TTL_MS);
  const person = {
    name: input.name,
    phone: input.phone ?? null,
    createdByStaffId: ctx.staff.id,
    emailVerifiedAt: verified ? now : null,
    createdAt: now,
  };
  let created: { user: User; accountId: string; tokenId: string; claimedOrders: number };
  try {
    created = await client.$transaction(async (tx) => {
      let user: User;
      if (existing) {
        // The address only has a team-invite placeholder: the staff-created customer takes the row over.
        const { count } = await tx.user.updateMany({ where: { email, ...PLACEHOLDER_USER_WHERE }, data: { ...person, passwordHash: null } });
        if (count !== 1) throw emailTakenError(CUSTOMER_RECORD_MESSAGES.emailTakenCustomer);
        user = await tx.user.findUniqueOrThrow({ where: { email } });
      } else {
        user = await tx.user.create({ data: { kind: "CUSTOMER", email, passwordHash: null, ...person } });
      }
      const account = await tx.businessAccount.create({
        data: {
          legalName,
          gstin: input.gstin ?? null,
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          pin: input.pin ?? null,
          createdAt: now,
        },
      });
      // The person's own account (invitedAt null): guest orders of a verified address are claimed into it.
      await tx.accountMember.create({
        data: { accountId: account.id, userId: user.id, role: "OWNER", status: "ACTIVE", invitedAt: null, createdAt: now },
      });
      const claim = verified ? await claimGuestOrders(tx, user) : null;
      const tokenId = await issueSetPasswordToken(tx, { userId: user.id, email, hash, expiresAt, issuedById: ctx.staff.id, now });
      await recordAccountActivity(tx, { accountId: account.id, actor: STAFF_ACTIVITY_ACTOR, action: "Created account", target: legalName, kind: "team", at: now });
      await audit(tx, ctx.actor, {
        action: "Created customer",
        target: email,
        targetType: "customer",
        targetId: account.id,
        reason,
        detail: `${legalName} · fields: ${createdCustomerFields(input).join(", ")}${verified ? " · email marked verified" : ""}${guestClaimNote(claim?.orderIds ?? [])}`,
      });
      return { user, accountId: account.id, tokenId, claimedOrders: claim?.orderIds.length ?? 0 };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw emailTakenError(CUSTOMER_RECORD_MESSAGES.emailTakenCustomer);
    throw error;
  }

  const url = resetUrl(`${created.tokenId}.${secret}`);
  const emailSent = await sendSetPasswordEmail({ to: email, name: input.name, url, expiresIn: setPasswordExpiresText(SET_PASSWORD_TTL_MS), businessName: legalName });
  log.info("admin_customer_created", { userId: created.user.id, accountId: created.accountId, emailSent, claimedOrders: created.claimedOrders });
  return {
    accountId: created.accountId,
    userId: created.user.id,
    email,
    emailVerified: verified,
    claimedOrders: created.claimedOrders,
    setPassword: { url, expiresAt: expiresAt.toISOString() },
    emailSent,
  };
}

// ---------- A3. Edit customer ----------

export type UpdateCustomerResult = { customer: AdminCustomerDetail; changed: boolean; signedOut: number; claimedOrders: number };

const DETAILS_SELECT = { legalName: true, gstin: true, address: true, city: true, state: true, pin: true } as const;

/**
 * PATCH /api/admin/customers/:id. Reason first (422, always), then in one transaction with the account row locked:
 * business details (GSTIN/state rule on the merged details, 422), the owner's name / mobile / email (409 `no_owner`
 * without an active owner, 409 `not_customer`, 409 `email_taken`, 422 `emailVerified` without an email change).
 * Nothing changed: `changed: false` and nothing written.
 */
export async function updateCustomer(accountId: string, input: CustomerPatchInput, ctx: CustomerRecordContext): Promise<UpdateCustomerResult> {
  const client = ctx.client ?? defaultDb;
  const now = ctx.now ?? new Date();
  const reason = requireReason(input.reason);
  assertMayVerify(ctx.staff.role, input.emailVerified);
  const personPatch = input.name !== undefined || input.phone !== undefined || input.email !== undefined;

  let outcome: { changed: boolean; signedOut: number; emailChanged: boolean; fields: string[]; claimedOrders: number };
  try {
    outcome = await client.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "BusinessAccount" WHERE "id" = ${accountId} FOR UPDATE`;
      if (locked.length === 0) throw errors.notFound("Customer");
      const row = await tx.businessAccount.findUniqueOrThrow({ where: { id: accountId }, select: DETAILS_SELECT });
      const current: BillingDetails = { ...row };
      const next = mergeBillingDetails(current, {
        legalName: input.legalName,
        gstin: input.gstin,
        address: input.address,
        city: input.city,
        state: input.state,
        pin: input.pin,
      });
      const issue = billingDetailsIssue(next);
      if (issue) throw errors.validation({ [issue.field]: issue.message });
      const businessChanged = BILLING_DETAIL_KEYS.filter((key) => next[key] !== current[key]);

      const owner = await tx.accountMember.findFirst({
        where: { accountId, role: "OWNER", status: "ACTIVE" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { user: true },
      });
      if (personPatch && !owner) throw errors.conflict("no_owner", CUSTOMER_RECORD_MESSAGES.noOwnerToEdit);
      if (personPatch && owner && owner.user.kind !== "CUSTOMER") throw notCustomerError();
      const user = owner?.user ?? null;
      const newEmail = user && input.email !== undefined && input.email !== user.email ? input.email : null;
      if (input.emailVerified === true && newEmail === null) {
        throw errors.validation({ emailVerified: CUSTOMER_RECORD_MESSAGES.emailVerifiedWithoutChange });
      }
      const fields = changedCustomerFields(
        user ? { name: user.name, phone: user.phone, email: user.email } : null,
        current,
        { name: input.name, phone: input.phone, email: input.email },
        next,
      );
      if (fields.length === 0) return { changed: false, signedOut: 0, emailChanged: false, fields, claimedOrders: 0 };

      if (businessChanged.length > 0) {
        await tx.businessAccount.update({ where: { id: accountId }, data: next });
        await recordAccountActivity(tx, {
          accountId,
          actor: STAFF_ACTIVITY_ACTOR,
          action: BILLING_ACTIVITY_ACTION,
          target: billingActivityTarget(next.gstin),
          kind: "billing",
          at: now,
        });
      }

      let signedOut = 0;
      let claimedOrders = 0;
      let auditTarget = user?.email ?? next.legalName;
      let emailNote = "";
      if (user) {
        const nameChange = input.name !== undefined && input.name !== user.name ? { name: input.name } : {};
        const phoneChange = input.phone !== undefined && input.phone !== user.phone ? { phone: input.phone } : {};
        if (newEmail === null) {
          if (Object.keys(nameChange).length > 0 || Object.keys(phoneChange).length > 0) {
            await tx.user.update({ where: { id: user.id }, data: { ...nameChange, ...phoneChange } });
          }
        } else {
          const taken = await tx.user.findUnique({ where: { email: newEmail }, select: { id: true } });
          if (taken) throw emailTakenError(CUSTOMER_RECORD_MESSAGES.emailTakenOther);
          const verified = input.emailVerified === true;
          // D9: a new security epoch (trusted devices need a code again), every session ends, open tokens die.
          const updated = await tx.user.update({
            where: { id: user.id },
            data: { ...nameChange, ...phoneChange, email: newEmail, emailVerifiedAt: verified ? now : null, securityEpoch: { increment: 1 } },
          });
          signedOut = await revokeAllSessions(tx, user.id, { now });
          await invalidateUserTokens(tx, user.id, ["EMAIL_VERIFY", "PASSWORD_RESET", "LOGIN_OTP"], now);
          // Team invitations were mailed to the old address: a link still sitting there must not set the password of
          // this account (lib/portal/invites.ts also refuses a link whose address no longer matches). Owners resend.
          const invites = await invalidateUserTokens(tx, user.id, ["TEAM_INVITE"], now);
          const claim = verified ? await claimGuestOrders(tx, updated) : null;
          claimedOrders = claim?.orderIds.length ?? 0;
          await enqueueEmail(tx, {
            to: user.email,
            templateId: "account_email_changed",
            vars: { customer_name: greetingName(updated.name), new_email_hint: emailHint(newEmail) },
            dedupeKey: `account_email_changed:${user.id}:${updated.securityEpoch}`,
          });
          auditTarget = newEmail;
          emailNote =
            ` · email was ${emailHint(user.email)} · signed out of ${signedOut} ${signedOut === 1 ? "session" : "sessions"}` +
            ` · ${verified ? "verified by staff" : "verification cleared"}` +
            (invites > 0 ? ` · ${invites} team ${invites === 1 ? "invitation" : "invitations"} voided` : "") +
            guestClaimNote(claim?.orderIds ?? []);
        }
      }

      await audit(tx, ctx.actor, {
        action: "Updated customer",
        target: auditTarget,
        targetType: "customer",
        targetId: accountId,
        reason,
        detail: `Changed: ${fields.join(", ")}${emailNote}`,
      });
      return { changed: true, signedOut, emailChanged: newEmail !== null, fields, claimedOrders };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw emailTakenError(CUSTOMER_RECORD_MESSAGES.emailTakenOther);
    throw error;
  }

  if (outcome.emailChanged) kickEmailDispatch();
  if (outcome.changed) {
    log.info("admin_customer_updated", { accountId, fields: outcome.fields, signedOut: outcome.signedOut, claimedOrders: outcome.claimedOrders });
  }
  const customer = await getAdminCustomerDetail(client, accountId, now);
  if (!customer) throw errors.notFound("Customer");
  return { customer, changed: outcome.changed, signedOut: outcome.signedOut, claimedOrders: outcome.claimedOrders };
}
