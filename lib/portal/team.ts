/**
 * "Team & access" (docs/decisions.md Phase 5 "Team"; api-contracts section 5 /api/account/team, Owner only).
 *
 * - Owners invite by email with role Billing admin, Technical contact or Viewer (Owner is granted later, to someone
 *   who has joined). A person without an account gets a placeholder user (no password) until they accept, or until
 *   they register or create an account at checkout, which takes the placeholder over (the invitation stays pending).
 *   Duplicates (active or invited) answer 409 "This person is already on your team.".
 * - Role changes apply immediately (every request re-reads the membership). Nobody changes their own role or removes
 *   themselves, and at least one active Owner always remains. Team changes of one account are serialised by a row
 *   lock on the BusinessAccount, so two owners demoting each other at once cannot leave the account without one.
 * - Removing an active member deletes the membership and clears that account from their sessions' active-account
 *   choice; revoking an invitation also voids its links (and drops a placeholder user nobody else references).
 * - Activity (kind "team"): Invited team member "{email} · {Role}", Changed role "{name} → {Role}", Removed team
 *   member "{name}", Revoked invite "{email}".
 * Server-only; routes check `team.manage`, and every write re-checks under the lock that the actor is still an Owner.
 */
import "server-only";
import type { PrismaClient, TeamRole } from "@/generated/prisma/client";
import { isUniqueViolation, PLACEHOLDER_USER_WHERE } from "@/lib/auth/flows/common";
import { TEAM_FORBIDDEN_MESSAGE } from "@/lib/auth/guards";
import { db as defaultDb, type Db, type Tx } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import { TEAM_ROLE_META } from "@/lib/rbac";
import { TEAM_ERRORS, TEAM_SIZE_LIMIT, type InviteMemberInput } from "@/lib/validation/team";
import { actorLabel, recordAccountActivity } from "./activity";
import { issueTeamInvite, sendTeamInviteEmail, voidTeamInvites, type TeamInviteEmail } from "./invites";

export type TeamMemberView = {
  /** AccountMember id: the `:memberId` of the team routes. */
  id: string;
  userId: string;
  /** "" while an invited person has not joined ("Invitation pending"). */
  name: string;
  email: string;
  role: TeamRole;
  roleLabel: string;
  status: "active" | "invited";
  /** The signed-in viewer ("You"). */
  you: boolean;
  lastActiveAt: string | null;
  invitedAt: string | null;
  /** Expiry of the open invitation link; null when no link is open (expired, voided, or never sent). */
  inviteExpiresAt: string | null;
  /** Invited, but no link that still works: offer "Resend". */
  inviteExpired: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
};

export type TeamView = { members: TeamMemberView[]; counts: { active: number; invited: number }; limit: number };

export type TeamActor = { id: string; name: string; email: string };

type MemberRow = {
  id: string;
  userId: string;
  role: TeamRole;
  status: "ACTIVE" | "INVITED";
  invitedAt: Date | null;
  user: { name: string; email: string; lastActiveAt: Date | null };
};

const MEMBER_SELECT = {
  id: true,
  userId: true,
  role: true,
  status: true,
  invitedAt: true,
  user: { select: { name: true, email: true, lastActiveAt: true } },
} as const;

function memberView(row: MemberRow, viewerUserId: string, openLinkExpiry: Date | null, now: Date): TeamMemberView {
  const you = row.userId === viewerUserId;
  const invited = row.status === "INVITED";
  const linkOpen = openLinkExpiry !== null && openLinkExpiry.getTime() > now.getTime();
  return {
    id: row.id,
    userId: row.userId,
    name: row.user.name,
    email: row.user.email,
    role: row.role,
    roleLabel: TEAM_ROLE_META[row.role].label,
    status: invited ? "invited" : "active",
    you,
    lastActiveAt: invited ? null : (row.user.lastActiveAt?.toISOString() ?? null),
    invitedAt: row.invitedAt?.toISOString() ?? null,
    inviteExpiresAt: invited && linkOpen ? (openLinkExpiry as Date).toISOString() : null,
    inviteExpired: invited && !linkOpen,
    canChangeRole: !you,
    canRemove: !you,
  };
}

/** Latest open TEAM_INVITE expiry per invited user of the account. */
async function openLinkExpiries(client: Db, accountId: string, userIds: string[]): Promise<Map<string, Date>> {
  if (userIds.length === 0) return new Map();
  const tokens = await client.authToken.findMany({
    where: { type: "TEAM_INVITE", userId: { in: userIds }, usedAt: null, meta: { path: ["accountId"], equals: accountId } },
    select: { userId: true, expiresAt: true },
  });
  const out = new Map<string, Date>();
  for (const t of tokens) {
    if (!t.userId) continue;
    const prev = out.get(t.userId);
    if (!prev || prev.getTime() < t.expiresAt.getTime()) out.set(t.userId, t.expiresAt);
  }
  return out;
}

/** Members and pending invitations: active first, then by when they were added. */
export async function listTeam(input: { accountId: string; viewerUserId: string; now?: Date }, client: Db = defaultDb): Promise<TeamView> {
  const now = input.now ?? new Date();
  const rows = await client.accountMember.findMany({
    where: { accountId: input.accountId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: MEMBER_SELECT,
  });
  const invitedIds = rows.filter((r) => r.status === "INVITED").map((r) => r.userId);
  const links = await openLinkExpiries(client, input.accountId, invitedIds);
  const sorted = [...rows.filter((r) => r.status === "ACTIVE"), ...rows.filter((r) => r.status === "INVITED")];
  return {
    members: sorted.map((r) => memberView(r, input.viewerUserId, links.get(r.userId) ?? null, now)),
    counts: { active: rows.length - invitedIds.length, invited: invitedIds.length },
    limit: TEAM_SIZE_LIMIT,
  };
}

// ---------- Writes ----------

/** Serialises team changes of one account for the rest of the transaction. */
async function lockAccount(tx: Tx, accountId: string): Promise<{ id: string; legalName: string }> {
  const rows = await tx.$queryRaw<{ id: string; legalName: string }[]>`
    SELECT "id", "legalName" FROM "BusinessAccount" WHERE "id" = ${accountId} FOR UPDATE`;
  const account = rows[0];
  if (!account) throw errors.notFound("Account");
  return account;
}

/** The actor must still be an active Owner (their role may have changed since the route checked it). */
async function assertOwner(tx: Tx, accountId: string, userId: string): Promise<void> {
  const owner = await tx.accountMember.findFirst({ where: { accountId, userId, status: "ACTIVE", role: "OWNER" }, select: { id: true } });
  if (!owner) throw errors.forbidden(TEAM_FORBIDDEN_MESSAGE);
}

async function otherActiveOwners(tx: Tx, accountId: string, exceptMemberId: string): Promise<number> {
  return tx.accountMember.count({ where: { accountId, role: "OWNER", status: "ACTIVE", id: { not: exceptMemberId } } });
}

async function findMember(tx: Tx, accountId: string, memberId: string): Promise<MemberRow> {
  const row = await tx.accountMember.findFirst({ where: { id: memberId, accountId }, select: MEMBER_SELECT });
  if (!row) throw errors.notFound("Team member");
  return row;
}

const duplicateError = () =>
  new ApiError(409, "already_member", TEAM_ERRORS.duplicate, { details: { fieldErrors: { email: [TEAM_ERRORS.duplicate] } } });
const lastOwnerError = () => errors.conflict("last_owner", TEAM_ERRORS.lastOwner);

/** `emailSent` false: the invitation exists but its email could not be sent (resend it). */
export type InviteResult = { member: TeamMemberView; inviteExpiresAt: string; emailSent: boolean };

type IssuedInvite = { member: TeamMemberView; inviteExpiresAt: string; email: TeamInviteEmail };

/** Sends the invitation email after the commit (never stored) and reports whether it went out. */
async function withEmailSent(issued: IssuedInvite): Promise<InviteResult> {
  const emailSent = await sendTeamInviteEmail(issued.email);
  return { member: issued.member, inviteExpiresAt: issued.inviteExpiresAt, emailSent };
}

async function inviteOnce(input: { accountId: string; actor: TeamActor; data: InviteMemberInput; now: Date }, client: PrismaClient): Promise<IssuedInvite> {
  const { accountId, actor, data, now } = input;
  return client.$transaction(async (tx) => {
    const account = await lockAccount(tx, accountId);
    await assertOwner(tx, accountId, actor.id);
    const size = await tx.accountMember.count({ where: { accountId } });
    if (size >= TEAM_SIZE_LIMIT) throw errors.conflict("team_full", TEAM_ERRORS.teamFull);

    let user = await tx.user.findUnique({ where: { email: data.email }, select: { id: true, email: true, kind: true } });
    if (user && user.kind !== "CUSTOMER") throw errors.validation({ email: TEAM_ERRORS.cannotInvite });
    if (user) {
      const existing = await tx.accountMember.findUnique({ where: { accountId_userId: { accountId, userId: user.id } }, select: { id: true } });
      if (existing) throw duplicateError();
    } else {
      // Placeholder until they accept: no password (cannot sign in or reset), no name, unverified.
      user = await tx.user.create({
        data: { kind: "CUSTOMER", email: data.email, name: "", passwordHash: null, createdAt: now },
        select: { id: true, email: true, kind: true },
      });
    }
    const member = await tx.accountMember.create({
      data: { accountId, userId: user.id, role: data.role, status: "INVITED", invitedAt: now, createdAt: now },
      select: MEMBER_SELECT,
    });
    const { expiresAt, email } = await issueTeamInvite(tx, {
      accountId,
      accountName: account.legalName,
      invitee: { id: user.id, email: user.email },
      role: data.role,
      inviter: { id: actor.id, name: actor.name },
      now,
    });
    await recordAccountActivity(tx, {
      accountId,
      actor: { id: actor.id, name: actorLabel(actor) },
      action: "Invited team member",
      target: `${user.email} \u00B7 ${TEAM_ROLE_META[data.role].label}`,
      kind: "team",
      at: now,
    });
    return { member: memberView(member, actor.id, expiresAt, now), inviteExpiresAt: expiresAt.toISOString(), email };
  });
}

/**
 * POST /api/account/team. 409 `already_member`, 409 `team_full`, 422 for staff addresses. A concurrent creation of the
 * same placeholder user (unique email) is retried once; a concurrent invite of the same person is a duplicate.
 */
export async function inviteMember(
  input: { accountId: string; actor: TeamActor; data: InviteMemberInput; now?: Date },
  client: PrismaClient = defaultDb,
): Promise<InviteResult> {
  const args = { ...input, now: input.now ?? new Date() };
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await withEmailSent(await inviteOnce(args, client));
      log.info("team_member_invited", { accountId: input.accountId, memberId: result.member.id, role: input.data.role, emailSent: result.emailSent });
      return result;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (attempt >= 2) throw duplicateError();
    }
  }
}

/**
 * PATCH /api/account/team/:memberId { role }. 403 `own_role`, 409 `last_owner`, 422 on `role` when making a pending
 * invitee an Owner. The same role again changes nothing (no log entry).
 */
export async function changeMemberRole(
  input: { accountId: string; actor: TeamActor; memberId: string; role: TeamRole; now?: Date },
  client: PrismaClient = defaultDb,
): Promise<{ member: TeamMemberView }> {
  const now = input.now ?? new Date();
  const result = await client.$transaction(async (tx) => {
    await lockAccount(tx, input.accountId);
    await assertOwner(tx, input.accountId, input.actor.id);
    const target = await findMember(tx, input.accountId, input.memberId);
    if (target.userId === input.actor.id) throw new ApiError(403, "own_role", TEAM_ERRORS.ownRole);
    const links = await openLinkExpiries(tx, input.accountId, target.status === "INVITED" ? [target.userId] : []);
    if (target.role === input.role) return { member: memberView(target, input.actor.id, links.get(target.userId) ?? null, now), changed: false };
    if (input.role === "OWNER" && target.status === "INVITED") throw errors.validation({ role: TEAM_ERRORS.ownerForInvite });
    if (target.role === "OWNER" && target.status === "ACTIVE" && (await otherActiveOwners(tx, input.accountId, target.id)) < 1) {
      throw lastOwnerError();
    }
    const updated = await tx.accountMember.update({ where: { id: target.id }, data: { role: input.role }, select: MEMBER_SELECT });
    await recordAccountActivity(tx, {
      accountId: input.accountId,
      actor: { id: input.actor.id, name: actorLabel(input.actor) },
      action: "Changed role",
      target: `${actorLabel(target.user)} \u2192 ${TEAM_ROLE_META[input.role].label}`,
      kind: "team",
      at: now,
    });
    return { member: memberView(updated, input.actor.id, links.get(target.userId) ?? null, now), changed: true };
  });
  if (result.changed) log.info("team_role_changed", { accountId: input.accountId, memberId: input.memberId, role: input.role });
  return { member: result.member };
}

export type RemoveResult = { removed: "member" | "invite"; memberId: string };

/**
 * DELETE /api/account/team/:memberId. Removes an active member (their sessions forget this account as the active one)
 * or revokes a pending invitation (links voided). 403 `remove_self`, 409 `last_owner`.
 */
export async function removeMember(
  input: { accountId: string; actor: TeamActor; memberId: string; now?: Date },
  client: PrismaClient = defaultDb,
): Promise<RemoveResult> {
  const now = input.now ?? new Date();
  const outcome = await client.$transaction(async (tx) => {
    await lockAccount(tx, input.accountId);
    await assertOwner(tx, input.accountId, input.actor.id);
    const target = await findMember(tx, input.accountId, input.memberId);
    if (target.userId === input.actor.id) throw new ApiError(403, "remove_self", TEAM_ERRORS.removeSelf);
    const invited = target.status === "INVITED";
    if (!invited && target.role === "OWNER" && (await otherActiveOwners(tx, input.accountId, target.id)) < 1) throw lastOwnerError();

    await tx.accountMember.delete({ where: { id: target.id } });
    if (invited) {
      await voidTeamInvites(tx, { accountId: input.accountId, userId: target.userId, now });
    } else {
      await tx.session.updateMany({ where: { userId: target.userId, activeAccountId: input.accountId }, data: { activeAccountId: null } });
    }
    await recordAccountActivity(tx, {
      accountId: input.accountId,
      actor: { id: input.actor.id, name: actorLabel(input.actor) },
      action: invited ? "Revoked invite" : "Removed team member",
      target: actorLabel(target.user),
      kind: "team",
      at: now,
    });
    return { invited, userId: target.userId };
  });
  if (outcome.invited) await dropUnusedPlaceholder(client, outcome.userId);
  log.info(outcome.invited ? "team_invite_revoked" : "team_member_removed", { accountId: input.accountId, memberId: input.memberId });
  return { removed: outcome.invited ? "invite" : "member", memberId: input.memberId };
}

/**
 * A placeholder user (never set a password, never verified) with no memberships left is deleted, so the address can
 * register normally. Best effort: anything referencing the row keeps it.
 */
async function dropUnusedPlaceholder(client: PrismaClient, userId: string): Promise<void> {
  try {
    await client.user.deleteMany({
      where: { id: userId, ...PLACEHOLDER_USER_WHERE, lastActiveAt: null, memberships: { none: {} } },
    });
  } catch (error) {
    log.warn("placeholder_user_kept", { userId, error });
  }
}

/** POST /api/account/team/:memberId/resend: a fresh 7-day link (older ones stop working). 409 `not_invited`. */
export async function resendInvite(
  input: { accountId: string; actor: TeamActor; memberId: string; now?: Date },
  client: PrismaClient = defaultDb,
): Promise<InviteResult> {
  const now = input.now ?? new Date();
  const issued = await client.$transaction(async (tx): Promise<IssuedInvite> => {
    const account = await lockAccount(tx, input.accountId);
    await assertOwner(tx, input.accountId, input.actor.id);
    const target = await findMember(tx, input.accountId, input.memberId);
    if (target.status !== "INVITED") throw errors.conflict("not_invited", TEAM_ERRORS.notInvited);
    const { expiresAt, email } = await issueTeamInvite(tx, {
      accountId: input.accountId,
      accountName: account.legalName,
      invitee: { id: target.userId, email: target.user.email },
      role: target.role,
      inviter: { id: input.actor.id, name: input.actor.name },
      now,
    });
    const updated = await tx.accountMember.update({ where: { id: target.id }, data: { invitedAt: now }, select: MEMBER_SELECT });
    return { member: memberView(updated, input.actor.id, expiresAt, now), inviteExpiresAt: expiresAt.toISOString(), email };
  });
  const result = await withEmailSent(issued);
  log.info("team_invite_resent", { accountId: input.accountId, memberId: input.memberId, emailSent: result.emailSent });
  return result;
}
