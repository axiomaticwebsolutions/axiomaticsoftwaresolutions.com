/**
 * Team invitations (docs/decisions.md Phase 5 "Team"): the TEAM_INVITE token and email, the public preview behind
 * /invite?token=, and acceptance.
 *
 * - Token "<AuthToken id>.<256-bit secret>"; only the SHA-256 of the secret is stored (AuthToken.codeHash), with
 *   `meta { accountId, role, invitedById }`. Valid INVITE_TTL_DAYS (7) days, single use. Sending again (resend, or a
 *   new invite of the same person) voids the person's older open links for that account.
 * - The invitee is a User: an existing customer, or a placeholder (no password, no name, unverified) created at invite
 *   time. Their AccountMember is INVITED until they accept; its current role (an owner may change it meanwhile) is the
 *   role they get.
 * - Accepting: someone who already has a password must be signed in as that email; a new person chooses a name and a
 *   password (policy) instead. Either way the link proves the address (emailVerifiedAt is set), the membership becomes
 *   ACTIVE, the session is rotated with the joined account active, and "Joined the team" is logged.
 * - The team_invite email carries the link, so it is never stored: issueTeamInvite() returns it and the caller sends it
 *   with sendTeamInviteEmail() after the inviting transaction commits (sendAuthEmail, like sign-in codes). A failed
 *   send is logged and reported to the caller; "Resend" issues a fresh link.
 * Server-only.
 */
import "server-only";
import type { AuthToken, PrismaClient, Session, TeamRole, User } from "@/generated/prisma/client";
import { claimGuestOrders } from "@/lib/auth/flows/claim-guest-orders";
import { newOpaqueSecret, secretMatches, splitOpaqueToken } from "@/lib/auth/flows/common";
import { hashPassword } from "@/lib/auth/password";
import { rotateSession } from "@/lib/auth/sessions";
import { DAY_MS, formatDateIST } from "@/lib/dates";
import { db as defaultDb, type Tx } from "@/lib/db";
import { sendAuthEmail } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { getEnv } from "@/lib/env";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import { isTeamRole, TEAM_ROLE_META } from "@/lib/rbac";
import { INVITE_TTL_DAYS, TEAM_ERRORS, type AcceptInviteInput } from "@/lib/validation/team";
import { actorLabel, recordAccountActivity } from "./activity";

export const INVITE_TTL_MS = INVITE_TTL_DAYS * DAY_MS;
export const INVITE_PATH = "/invite";
export const TEAM_INVITE_TEMPLATE = "team_invite";
/** Where an accepted invitation continues. */
export const INVITE_ACCEPTED_REDIRECT = "/account";

export const INVITE_MESSAGES = {
  invalid: TEAM_ERRORS.token,
  expired: "This invitation has expired. Ask the account owner to send a new one.",
  revoked: "This invitation is no longer valid. Ask the account owner to send a new one.",
  used: "This invitation has already been accepted. Sign in to continue.",
  staff: "Staff accounts can’t join a customer team. Ask the owner to invite a different email address.",
  changed: "This invitation changed while you were accepting it. Open the link again.",
} as const;

export function signInToAcceptMessage(email: string): string {
  return `Sign in as ${email} to accept this invitation.`;
}

export function wrongAccountMessage(email: string): string {
  return `This invitation is for ${email}. Sign out, then sign in with that email to accept it.`;
}

// ---------- Email ----------

const URL_LIKE_RE =
  /[@\x5C<>]|:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|in|io|co|info|biz|xyz|app|dev|me|ly|ru|cn|top|site|online|link|shop|click|ai|us|uk|live|store|pro|tech|cloud|email|page|vip|club|win|icu|tk|cc)\b/i;
const PHONE_LIKE_RE = /\d{5,}|\d[\d -]{7,}\d/;

/**
 * Account names are typed by whoever registered and are mailed to any address an owner enters, so a name that looks
 * like a link, an address or a phone number is replaced (same reasoning as lib/email/greeting.ts).
 */
export function emailSafeAccountName(legalName: string): string {
  const clean = legalName.replace(/[\p{Cc}\s]+/gu, " ").trim();
  if (clean === "" || clean.length > 120 || URL_LIKE_RE.test(clean) || PHONE_LIKE_RE.test(clean)) return "a business account";
  return clean;
}

export function emailSafeInviterName(name: string): string {
  const safe = greetingName(name);
  return safe === "there" ? "A teammate" : safe;
}

export function inviteUrl(token: string): string {
  return `${getEnv().APP_URL}${INVITE_PATH}?token=${encodeURIComponent(token)}`;
}

export type InviteMeta = { accountId: string; role: TeamRole; invitedById: string | null };

function readMeta(token: Pick<AuthToken, "meta">): InviteMeta | null {
  const meta = token.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const m = meta as Record<string, unknown>;
  if (typeof m.accountId !== "string" || !isTeamRole(m.role)) return null;
  return { accountId: m.accountId, role: m.role, invitedById: typeof m.invitedById === "string" ? m.invitedById : null };
}

/** Voids every open invitation link of this person for this account. */
export async function voidTeamInvites(tx: Tx, input: { accountId: string; userId: string; now: Date }): Promise<number> {
  const { count } = await tx.authToken.updateMany({
    where: { type: "TEAM_INVITE", userId: input.userId, usedAt: null, meta: { path: ["accountId"], equals: input.accountId } },
    data: { usedAt: input.now },
  });
  return count;
}

/** A team_invite email to send after the inviting transaction commits. Holds the link: never store or log it. */
export type TeamInviteEmail = { to: string; vars: Record<string, string> };

export type IssueInviteInput = {
  accountId: string;
  accountName: string;
  invitee: { id: string; email: string };
  role: TeamRole;
  inviter: { id: string; name: string };
  now: Date;
};

/**
 * Inside the inviting transaction: voids the person's older links for this account and stores a new token. Returns the
 * link expiry and the team_invite email, which the caller sends with sendTeamInviteEmail() after the commit (so a
 * retried or rolled-back transaction never mails, and the link is never stored).
 */
export async function issueTeamInvite(
  tx: Tx,
  input: IssueInviteInput,
): Promise<{ tokenId: string; expiresAt: Date; email: TeamInviteEmail }> {
  await voidTeamInvites(tx, { accountId: input.accountId, userId: input.invitee.id, now: input.now });
  const { secret, hash } = newOpaqueSecret();
  const expiresAt = new Date(input.now.getTime() + INVITE_TTL_MS);
  const meta: InviteMeta = { accountId: input.accountId, role: input.role, invitedById: input.inviter.id };
  const row = await tx.authToken.create({
    data: {
      type: "TEAM_INVITE",
      userId: input.invitee.id,
      email: input.invitee.email,
      codeHash: hash,
      expiresAt,
      meta,
      createdAt: input.now,
    },
    select: { id: true },
  });
  const email: TeamInviteEmail = {
    to: input.invitee.email,
    vars: {
      inviter_name: emailSafeInviterName(input.inviter.name),
      account_name: emailSafeAccountName(input.accountName),
      role_label: TEAM_ROLE_META[input.role].label,
      invite_url: inviteUrl(`${row.id}.${secret}`),
      expires: formatDateIST(expiresAt),
    },
  };
  return { tokenId: row.id, expiresAt, email };
}

/** Sends a team_invite email now (after the commit); never stored, never throws. False when it could not be sent. */
export async function sendTeamInviteEmail(email: TeamInviteEmail): Promise<boolean> {
  const { ok } = await sendAuthEmail({ to: email.to, templateId: TEAM_INVITE_TEMPLATE, vars: email.vars });
  if (!ok) log.warn("team_invite_email_failed", { template: TEAM_INVITE_TEMPLATE });
  return ok;
}

type ResolvedInvite = {
  token: AuthToken & { meta: unknown };
  meta: InviteMeta;
  member: { id: string; role: TeamRole; status: "ACTIVE" | "INVITED" };
  account: { id: string; legalName: string };
  invitee: User;
};

/**
 * Looks the token up and explains why it cannot be used: 404 `invite_invalid` (malformed, unknown, wrong secret,
 * account gone), 410 `invite_used` (already accepted), 410 `invite_revoked` (revoked, replaced by a newer link, or
 * the person was removed), 410 `invite_expired`.
 */
export async function resolveInvite(client: PrismaClient | Tx, rawToken: string, now: Date): Promise<ResolvedInvite> {
  const invalid = () => new ApiError(404, "invite_invalid", INVITE_MESSAGES.invalid);
  const parts = splitOpaqueToken(rawToken.trim());
  if (!parts) throw invalid();
  const token = await client.authToken.findUnique({ where: { id: parts.id } });
  if (!token || token.type !== "TEAM_INVITE" || !token.userId || !secretMatches(parts.secret, token.codeHash)) throw invalid();
  const meta = readMeta(token);
  if (!meta) throw invalid();
  // Sequential: `client` can be an interactive transaction (one connection, one query at a time).
  const account = await client.businessAccount.findUnique({ where: { id: meta.accountId }, select: { id: true, legalName: true } });
  const invitee = await client.user.findUnique({ where: { id: token.userId } });
  const member = await client.accountMember.findUnique({
    where: { accountId_userId: { accountId: meta.accountId, userId: token.userId } },
    select: { id: true, role: true, status: true },
  });
  if (!account || !invitee) throw invalid();
  if (token.usedAt) {
    if (member?.status === "ACTIVE") throw new ApiError(410, "invite_used", INVITE_MESSAGES.used);
    throw new ApiError(410, "invite_revoked", INVITE_MESSAGES.revoked);
  }
  if (!member) throw new ApiError(410, "invite_revoked", INVITE_MESSAGES.revoked);
  if (member.status === "ACTIVE") throw new ApiError(410, "invite_used", INVITE_MESSAGES.used);
  if (token.expiresAt.getTime() <= now.getTime()) throw new ApiError(410, "invite_expired", INVITE_MESSAGES.expired);
  return { token, meta, member, account, invitee };
}

export type InvitePreview = {
  email: string;
  accountName: string;
  role: TeamRole;
  roleLabel: string;
  roleDescription: string;
  inviterName: string | null;
  expiresAt: string;
  /** The invitee already has a password: they sign in to accept instead of creating one. */
  accountExists: boolean;
  viewer: { signedIn: boolean; isInvitee: boolean };
};

/** GET /api/invites/:token. Read-only; the token is the credential, so the account name may be shown. */
export async function previewInvite(
  input: { token: string; viewerUserId: string | null; now?: Date },
  client: PrismaClient = defaultDb,
): Promise<InvitePreview> {
  const now = input.now ?? new Date();
  const invite = await resolveInvite(client, input.token, now);
  const inviter = invite.meta.invitedById
    ? await client.user.findUnique({ where: { id: invite.meta.invitedById }, select: { name: true, email: true } })
    : null;
  return {
    email: invite.invitee.email,
    accountName: invite.account.legalName,
    role: invite.member.role,
    roleLabel: TEAM_ROLE_META[invite.member.role].label,
    roleDescription: TEAM_ROLE_META[invite.member.role].description,
    inviterName: inviter ? actorLabel(inviter) : null,
    expiresAt: invite.token.expiresAt.toISOString(),
    accountExists: invite.invitee.passwordHash !== null,
    viewer: { signedIn: input.viewerUserId !== null, isInvitee: input.viewerUserId === invite.invitee.id },
  };
}

export type AcceptInviteContext = {
  /** The current session, when signed in. */
  current: { userId: string; sessionId: string } | null;
  ip: string | null;
  userAgent: string | null;
  now?: Date;
};

export type AcceptInviteResult = {
  user: User;
  accountId: string;
  /** Raw session token for the cookie (the session was rotated). */
  token: string;
  session: Session;
  redirectTo: string;
};

/**
 * POST /api/invites/accept. Existing account: 401 `sign_in_required` when signed out, 403 `wrong_account` when signed
 * in as someone else. New person: 422 on `name` / `password` when missing or not acceptable. Staff: 403 `staff_account`.
 * Then, in one transaction: token used, membership ACTIVE, other links voided, user updated (name + password for a
 * new person; email verified), the newly verified person's guest orders claimed into an account they created
 * themselves (ownAccountId; never the joined account, so a new person's stay unclaimed), "Joined the team" logged,
 * session rotated with the joined account active. A concurrent revoke or second acceptance makes it 410/409 with no
 * change.
 */
export async function acceptInvite(
  input: AcceptInviteInput,
  ctx: AcceptInviteContext,
  client: PrismaClient = defaultDb,
): Promise<AcceptInviteResult> {
  const now = ctx.now ?? new Date();
  const invite = await resolveInvite(client, input.token, now);
  const { invitee, meta } = invite;
  if (invitee.kind !== "CUSTOMER") throw new ApiError(403, "staff_account", INVITE_MESSAGES.staff);

  const existing = invitee.passwordHash !== null;
  let newPasswordHash: string | null = null;
  if (existing) {
    if (!ctx.current) throw new ApiError(401, "sign_in_required", signInToAcceptMessage(invitee.email), { details: { email: invitee.email } });
    if (ctx.current.userId !== invitee.id) {
      throw new ApiError(403, "wrong_account", wrongAccountMessage(invitee.email), { details: { email: invitee.email } });
    }
  } else {
    const missing: Record<string, string> = {};
    if (input.name === undefined) missing.name = TEAM_ERRORS.name;
    if (input.password === undefined) missing.password = TEAM_ERRORS.password;
    if (Object.keys(missing).length > 0) throw errors.validation(missing);
    newPasswordHash = await hashPassword(input.password as string);
  }

  const result = await client.$transaction(async (tx) => {
    const used = await tx.authToken.updateMany({
      where: { id: invite.token.id, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (used.count !== 1) throw new ApiError(410, "invite_revoked", INVITE_MESSAGES.revoked);
    const joined = await tx.accountMember.updateMany({
      where: { id: invite.member.id, accountId: meta.accountId, userId: invitee.id, status: "INVITED" },
      data: { status: "ACTIVE" },
    });
    if (joined.count !== 1) throw new ApiError(410, "invite_revoked", INVITE_MESSAGES.revoked);
    await voidTeamInvites(tx, { accountId: meta.accountId, userId: invitee.id, now });

    const verifiedNow = invitee.emailVerifiedAt === null;
    const updated = await tx.user.updateMany({
      where: existing ? { id: invitee.id } : { id: invitee.id, passwordHash: null },
      data: {
        ...(existing ? {} : { name: input.name as string, passwordHash: newPasswordHash }),
        ...(verifiedNow ? { emailVerifiedAt: now } : {}),
        lastActiveAt: now,
      },
    });
    if (updated.count !== 1) throw new ApiError(409, "invite_changed", INVITE_MESSAGES.changed);
    const user = await tx.user.findUniqueOrThrow({ where: { id: invitee.id } });
    if (verifiedNow) await claimGuestOrders(tx, user);

    const member = await tx.accountMember.findUniqueOrThrow({ where: { id: invite.member.id }, select: { role: true } });
    await recordAccountActivity(tx, {
      accountId: meta.accountId,
      actor: { id: user.id, name: actorLabel(user) },
      action: "Joined the team",
      target: `${user.email} \u00B7 ${TEAM_ROLE_META[member.role].label}`,
      kind: "team",
      at: now,
    });
    const { token, session } = await rotateSession(tx, ctx.current?.sessionId ?? null, {
      userId: user.id,
      kind: "CUSTOMER",
      userAgent: ctx.userAgent,
      ip: ctx.ip,
      activeAccountId: meta.accountId,
      now,
    });
    return { user, token, session };
  });
  log.info("team_invite_accepted", { userId: result.user.id, accountId: meta.accountId, newUser: !existing });
  return { ...result, accountId: meta.accountId, redirectTo: INVITE_ACCEPTED_REDIRECT };
}
