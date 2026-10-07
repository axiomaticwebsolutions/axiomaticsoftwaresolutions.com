/**
 * Staff invitations (decisions.md Phase 6 "Staff"): the STAFF_INVITE token and email, the public preview behind
 * /staff-invite?token= and acceptance.
 *
 * - Token "<AuthToken id>.<256-bit secret>"; only the SHA-256 of the secret is stored (AuthToken.codeHash), with
 *   `meta { staffRole, invitedById }`. Valid 7 days, single use; sending again voids the person's older links.
 * - The staff_invite email carries the link, so it is never stored: issueStaffInvite() returns it and the caller sends
 *   it with sendStaffInviteEmail() after the transaction commits (sendAuthEmail, like sign-in codes). A failed send is
 *   logged and reported to the caller; "Resend" issues a fresh link.
 * - The invitee is a STAFF user created at invite time (staffStatus INVITED, no password, unverified, name ""). The
 *   role they get is the user's current staffRole (the Owner may change it while the invitation is open).
 * - Accepting sets the name and a password (policy), verifies the email, activates the account (two-step on for
 *   Owner and Finance), writes "Accepted staff invitation" to the audit log and signs the person in. Anyone already
 *   signed in on that browser (customer or staff) is asked to sign out first.
 * Server-only.
 */
import "server-only";
import type { AuthToken, PrismaClient, Session, StaffRole, User } from "@/generated/prisma/client";
import { actorFromStaff, audit } from "@/lib/audit";
import { newOpaqueSecret, secretMatches, splitOpaqueToken } from "@/lib/auth/flows/common";
import { hashPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/sessions";
import { DAY_MS, formatDateIST } from "@/lib/dates";
import { db as defaultDb, type Tx } from "@/lib/db";
import { sendAuthEmail } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { getEnv } from "@/lib/env";
import { ApiError, ipPrefix } from "@/lib/http";
import { log } from "@/lib/log";
import { isStaffRole } from "@/lib/rbac";
import {
  requiresTwoStep,
  roleLabel,
  ROLE_SUMMARIES,
  STAFF_ERRORS,
  STAFF_HOME_PATH,
  STAFF_INVITE_PATH,
  STAFF_INVITE_TEMPLATE,
  STAFF_INVITE_TTL_DAYS,
  type AcceptStaffInviteInput,
} from "./model";

export const STAFF_INVITE_TTL_MS = STAFF_INVITE_TTL_DAYS * DAY_MS;

export const STAFF_INVITE_MESSAGES = {
  invalid: STAFF_ERRORS.token,
  expired: "This invitation has expired. Ask the account owner to send a new one.",
  revoked: "This invitation is no longer valid. Ask the account owner to send a new one.",
  used: "This invitation has already been accepted. Sign in to continue.",
  changed: "This invitation changed while you were accepting it. Open the link again.",
} as const;

/** 403 `signed_in`: a session exists on this browser; the invitee has none yet. */
export function signedInElsewhereMessage(email: string): string {
  return `You\u2019re signed in as ${email}. Sign out, then open the invitation link again.`;
}

export function staffInviteUrl(token: string): string {
  return `${getEnv().APP_URL}${STAFF_INVITE_PATH}?token=${encodeURIComponent(token)}`;
}

/** Inviter name for the email: the staff member's name, or a neutral phrase when it is blank or looks like a link. */
export function inviterNameForEmail(name: string | null | undefined): string {
  const safe = greetingName(name);
  return safe === "there" ? "The Axiomatic team" : safe;
}

export type StaffInviteMeta = { staffRole: StaffRole; invitedById: string | null };

function readMeta(token: Pick<AuthToken, "meta">): StaffInviteMeta | null {
  const meta = token.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  if (!isStaffRole(m.staffRole)) return null;
  return { staffRole: m.staffRole, invitedById: typeof m.invitedById === "string" ? m.invitedById : null };
}

/** Voids every open invitation link of this person. */
export async function voidStaffInvites(tx: Tx, userId: string, now: Date): Promise<number> {
  const { count } = await tx.authToken.updateMany({
    where: { type: "STAFF_INVITE", userId, usedAt: null },
    data: { usedAt: now },
  });
  return count;
}

/** A staff_invite email to send after the inviting transaction commits. Holds the link: never store or log it. */
export type StaffInviteEmail = { to: string; vars: Record<string, string> };

export type IssueStaffInviteInput = {
  invitee: { id: string; email: string; role: StaffRole };
  inviter: { id: string; name: string };
  now: Date;
};

/**
 * Inside the inviting transaction: voids the person's older links and stores a new token. Returns the staff_invite
 * email, which the caller sends with sendStaffInviteEmail() once the transaction has committed (never stored).
 */
export async function issueStaffInvite(
  tx: Tx,
  input: IssueStaffInviteInput,
): Promise<{ tokenId: string; expiresAt: Date; email: StaffInviteEmail }> {
  await voidStaffInvites(tx, input.invitee.id, input.now);
  const { secret, hash } = newOpaqueSecret();
  const expiresAt = new Date(input.now.getTime() + STAFF_INVITE_TTL_MS);
  const meta: StaffInviteMeta = { staffRole: input.invitee.role, invitedById: input.inviter.id };
  const row = await tx.authToken.create({
    data: {
      type: "STAFF_INVITE",
      userId: input.invitee.id,
      email: input.invitee.email,
      codeHash: hash,
      expiresAt,
      meta,
      createdAt: input.now,
    },
    select: { id: true },
  });
  const email: StaffInviteEmail = {
    to: input.invitee.email,
    vars: {
      inviter_name: inviterNameForEmail(input.inviter.name),
      role_label: roleLabel(input.invitee.role),
      invite_url: staffInviteUrl(`${row.id}.${secret}`),
      expires: formatDateIST(expiresAt),
    },
  };
  return { tokenId: row.id, expiresAt, email };
}

/** Sends a staff_invite email now (after the commit); never stored, never throws. False when it could not be sent. */
export async function sendStaffInviteEmail(email: StaffInviteEmail): Promise<boolean> {
  const { ok } = await sendAuthEmail({ to: email.to, templateId: STAFF_INVITE_TEMPLATE, vars: email.vars });
  if (!ok) log.warn("staff_invite_email_failed", { template: STAFF_INVITE_TEMPLATE });
  return ok;
}

type ResolvedStaffInvite = { token: AuthToken; meta: StaffInviteMeta; invitee: User & { staffRole: StaffRole } };

/**
 * Looks the token up and explains why it cannot be used: 404 `invite_invalid` (malformed, unknown, wrong secret, not a
 * staff invitation, person gone), 410 `invite_used` (accepted), 410 `invite_revoked` (replaced by a newer link,
 * revoked, or the person's access changed), 410 `invite_expired`.
 */
export async function resolveStaffInvite(client: PrismaClient | Tx, rawToken: string, now: Date): Promise<ResolvedStaffInvite> {
  const invalid = () => new ApiError(404, "invite_invalid", STAFF_INVITE_MESSAGES.invalid);
  const parts = splitOpaqueToken(rawToken.trim());
  if (!parts) throw invalid();
  const token = await client.authToken.findUnique({ where: { id: parts.id } });
  if (!token || token.type !== "STAFF_INVITE" || !token.userId || !secretMatches(parts.secret, token.codeHash)) throw invalid();
  const meta = readMeta(token);
  if (!meta) throw invalid();
  const invitee = await client.user.findUnique({ where: { id: token.userId } });
  if (!invitee || invitee.kind !== "STAFF" || !invitee.staffRole) throw invalid();
  if (invitee.staffStatus === "ACTIVE") throw new ApiError(410, "invite_used", STAFF_INVITE_MESSAGES.used);
  if (token.usedAt || invitee.staffStatus !== "INVITED" || invitee.passwordHash !== null) {
    throw new ApiError(410, "invite_revoked", STAFF_INVITE_MESSAGES.revoked);
  }
  if (token.expiresAt.getTime() <= now.getTime()) throw new ApiError(410, "invite_expired", STAFF_INVITE_MESSAGES.expired);
  return { token, meta, invitee: { ...invitee, staffRole: invitee.staffRole } };
}

export type StaffInvitePreview = {
  email: string;
  role: StaffRole;
  roleLabel: string;
  roleSummary: string;
  /** Owner and Finance sign in with an emailed code as well as the password. */
  twoStep: boolean;
  inviterName: string | null;
  expiresAt: string;
  /** Someone is signed in on this browser (they must sign out first). */
  viewer: { signedIn: boolean; email: string | null };
};

/** GET /api/staff-invites/:token. Read-only; the token is the credential. */
export async function previewStaffInvite(
  input: { token: string; viewer: { email: string } | null; now?: Date },
  client: PrismaClient = defaultDb,
): Promise<StaffInvitePreview> {
  const now = input.now ?? new Date();
  const { token, meta, invitee } = await resolveStaffInvite(client, input.token, now);
  const inviter = meta.invitedById
    ? await client.user.findUnique({ where: { id: meta.invitedById }, select: { name: true, email: true } })
    : null;
  return {
    email: invitee.email,
    role: invitee.staffRole,
    roleLabel: roleLabel(invitee.staffRole),
    roleSummary: ROLE_SUMMARIES[invitee.staffRole],
    twoStep: requiresTwoStep(invitee.staffRole),
    inviterName: inviter ? inviter.name.trim() || inviter.email : null,
    expiresAt: token.expiresAt.toISOString(),
    viewer: { signedIn: input.viewer !== null, email: input.viewer?.email ?? null },
  };
}

export type AcceptStaffInviteContext = {
  /** The current session's user, when signed in on this browser. */
  current: { email: string } | null;
  ip: string | null;
  userAgent: string | null;
  now?: Date;
};

export type AcceptStaffInviteResult = { user: User; token: string; session: Session; redirectTo: string };

/**
 * POST /api/staff-invites/accept. 403 `signed_in` when a session exists on the browser. Then, in one transaction:
 * token used (only while open and unexpired), the user activated with the name, password and a verified email
 * (two-step on for Owner and Finance), other links voided, the audit row written and a staff session created.
 * A concurrent revoke or second acceptance answers 410/409 with no change.
 */
export async function acceptStaffInvite(
  input: AcceptStaffInviteInput,
  ctx: AcceptStaffInviteContext,
  client: PrismaClient = defaultDb,
): Promise<AcceptStaffInviteResult> {
  const now = ctx.now ?? new Date();
  if (ctx.current) throw new ApiError(403, "signed_in", signedInElsewhereMessage(ctx.current.email), { details: { email: ctx.current.email } });
  const invite = await resolveStaffInvite(client, input.token, now);
  const role = invite.invitee.staffRole;
  const passwordHash = await hashPassword(input.password);

  const result = await client.$transaction(async (tx) => {
    const used = await tx.authToken.updateMany({
      where: { id: invite.token.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (used.count !== 1) throw new ApiError(410, "invite_revoked", STAFF_INVITE_MESSAGES.revoked);
    const activated = await tx.user.updateMany({
      where: { id: invite.invitee.id, kind: "STAFF", staffStatus: "INVITED", staffRole: role, passwordHash: null },
      data: {
        name: input.name,
        passwordHash,
        staffStatus: "ACTIVE",
        emailVerifiedAt: now,
        lastActiveAt: now,
        ...(requiresTwoStep(role) ? { twoStepEnabled: true } : {}),
      },
    });
    if (activated.count !== 1) throw new ApiError(409, "invite_changed", STAFF_INVITE_MESSAGES.changed);
    await voidStaffInvites(tx, invite.invitee.id, now);
    const user = await tx.user.findUniqueOrThrow({ where: { id: invite.invitee.id } });
    await audit(tx, actorFromStaff(user, ipPrefix(ctx.ip)), {
      action: "Accepted staff invitation",
      target: user.email,
      targetType: "staff",
      targetId: user.id,
      detail: roleLabel(role),
    });
    const { token, session } = await createSession(tx, { userId: user.id, kind: "STAFF", userAgent: ctx.userAgent, ip: ctx.ip, now });
    return { user, token, session };
  });
  log.info("staff_invite_accepted", { userId: result.user.id, role });
  return { ...result, redirectTo: STAFF_HOME_PATH };
}
