/**
 * Staff & roles service (decisions.md Phase 6 "Staff"; Owner only, the routes check staff.manage):
 *
 * - listStaff / getStaffMember: STAFF users as StaffRow (role, status, two-step, last active, open invitation).
 * - inviteStaff: a new STAFF user (INVITED, no password) + STAFF_INVITE token + staff_invite email + "Invited staff".
 *   Customer emails are refused (staff and customers are separate users), as are existing staff.
 * - resendStaffInvite / revokeStaffInvite: a fresh link (older ones void) / the invited user removed. The staff_invite
 *   email holds the link, so it is sent directly after the commit and never stored (lib/admin/staff/invites.ts);
 *   `emailSent` reports a failed send (the Owner can resend).
 * - changeStaffRole / deactivateStaff / reactivateStaff: DESTRUCTIVE_ACTIONS through runDestructive (reason, exactly one
 *   audit row in the same transaction). Not on yourself; at least one active Owner remains (the active Owner rows are
 *   locked, so two concurrent demotions cannot both pass). Owner and Finance always get two-step sign-in. A role change
 *   signs the person out everywhere and voids their open sign-in codes, so a new role (Owner and Finance with two-step)
 *   starts from a fresh sign-in; deactivation also voids reset and verification codes.
 * Server-only.
 */
import "server-only";
import type { Prisma, StaffRole, User } from "@/generated/prisma/client";
import { runDestructive, type DestructiveInput } from "@/lib/admin/destructive";
import { pageResult, searchWhere, toPrismaOrderBy, type ListPage, type ListQuery } from "@/lib/admin/list-query";
import { audit, type AuditActor } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/auth/flows/common";
import { db as defaultDb, type Db, type Tx } from "@/lib/db";
import { errors, type ApiError } from "@/lib/http";
import { log } from "@/lib/log";
import { issueStaffInvite, sendStaffInviteEmail, voidStaffInvites, type StaffInviteEmail } from "./invites";
import {
  requiresTwoStep,
  ROLE_FILTER_TO_ENUM,
  roleLabel,
  sameRoleMessage,
  STAFF_ERRORS,
  type STAFF_LIST_SPEC,
  STATUS_KEY_TO_ENUM,
  staffDisplayName,
  staffStatusKey,
  type InviteStaffInput,
  type StaffInviteInfo,
  type StaffRow,
  type StaffSort,
} from "./model";

export type StaffListQuery = ListQuery<typeof STAFF_LIST_SPEC.filters, StaffSort>;

/** The acting staff member (route ctx.staff + ctx.actor). */
export type StaffActor = { staff: { id: string; name: string; role: StaffRole }; actor: AuditActor };

/** An invitation (new or resent) and whether its email went out. */
export type StaffInviteOutcome = { staff: StaffRow; emailSent: boolean };

const STAFF_SELECT = {
  id: true,
  name: true,
  email: true,
  kind: true,
  staffRole: true,
  staffStatus: true,
  twoStepEnabled: true,
  lastActiveAt: true,
  createdAt: true,
} as const satisfies Prisma.UserSelect;

type StaffRecord = Prisma.UserGetPayload<{ select: typeof STAFF_SELECT }>;

/** Latest invitation link per invited user (open = unused; expired when past expiresAt). */
async function openInvites(client: Db, userIds: readonly string[], now: Date): Promise<Map<string, StaffInviteInfo>> {
  const out = new Map<string, StaffInviteInfo>();
  if (userIds.length === 0) return out;
  const tokens = await client.authToken.findMany({
    where: { type: "STAFF_INVITE", userId: { in: [...userIds] }, usedAt: null },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { userId: true, createdAt: true, expiresAt: true },
  });
  for (const t of tokens) {
    if (!t.userId || out.has(t.userId)) continue;
    out.set(t.userId, { sentAt: t.createdAt.toISOString(), expiresAt: t.expiresAt.toISOString(), expired: t.expiresAt.getTime() <= now.getTime() });
  }
  return out;
}

function toStaffRow(user: StaffRecord, invite: StaffInviteInfo | undefined): StaffRow {
  const status = staffStatusKey(user.staffStatus);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.staffRole ?? "SUPPORT",
    status,
    twoStepEnabled: user.twoStepEnabled,
    lastActiveAt: user.lastActiveAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
    invite: status === "invited" ? (invite ?? null) : null,
  };
}

function listWhere(query: Pick<StaffListQuery, "q" | "filters">): Prisma.UserWhereInput {
  const where: Prisma.UserWhereInput = { kind: "STAFF", staffRole: { not: null } };
  if (query.filters.role) where.staffRole = ROLE_FILTER_TO_ENUM[query.filters.role];
  if (query.filters.status) where.staffStatus = STATUS_KEY_TO_ENUM[query.filters.status];
  const search = searchWhere<Prisma.UserWhereInput>(query.q, ["name", "email"]);
  return search ? { AND: [where, search] } : where;
}

/** GET /api/admin/staff and the Staff page. */
export async function listStaff(client: Db, query: StaffListQuery, now: Date = new Date()): Promise<ListPage<StaffRow>> {
  const where = listWhere(query);
  const orderBy = toPrismaOrderBy<Prisma.UserOrderByWithRelationInput>(query.sort, {
    name: (dir) => [{ name: dir }, { email: dir }],
    role: (dir) => [{ staffRole: dir }, { staffStatus: "asc" }, { name: "asc" }, { email: "asc" }],
    status: (dir) => [{ staffStatus: dir }, { name: "asc" }, { email: "asc" }],
    lastActive: { path: "lastActiveAt", nulls: "last" },
  });
  const [users, total] = await Promise.all([
    client.user.findMany({ where, orderBy, skip: query.skip, take: query.take, select: STAFF_SELECT }),
    client.user.count({ where }),
  ]);
  const invites = await openInvites(client, users.filter((u) => u.staffStatus === "INVITED").map((u) => u.id), now);
  return pageResult(users.map((u) => toStaffRow(u, invites.get(u.id))), total, query);
}

/** Every staff member matching the list filters (CSV export; at most `limit`). */
export async function exportStaff(client: Db, query: StaffListQuery, limit: number, now: Date = new Date()): Promise<StaffRow[]> {
  const page = await listStaff(client, { ...query, skip: 0, take: limit, page: 1, pageSize: limit }, now);
  return page.items;
}

/** GET /api/admin/staff/:id (404 for anyone who is not staff). */
export async function getStaffMember(client: Db, id: string, now: Date = new Date()): Promise<StaffRow> {
  const user = await client.user.findUnique({ where: { id }, select: STAFF_SELECT });
  if (!user || user.kind !== "STAFF" || !user.staffRole) throw errors.notFound("Staff member");
  const invites = await openInvites(client, user.staffStatus === "INVITED" ? [user.id] : [], now);
  return toStaffRow(user, invites.get(user.id));
}

// ---------- Invitations ----------

/** Why `email` cannot be invited (409), or null when it is free. */
function inviteConflict(existing: Pick<User, "kind" | "staffStatus"> | null): ApiError | null {
  if (!existing) return null;
  if (existing.kind !== "STAFF") return errors.conflict("customer_email", STAFF_ERRORS.customerEmail);
  if (existing.staffStatus === "INVITED") return errors.conflict("already_invited", STAFF_ERRORS.alreadyInvited);
  if (existing.staffStatus === "DEACTIVATED") return errors.conflict("staff_deactivated", STAFF_ERRORS.deactivated);
  return errors.conflict("already_staff", STAFF_ERRORS.alreadyStaff);
}

/**
 * POST /api/admin/staff. 409 `customer_email` | `already_staff` | `already_invited` | `staff_deactivated`;
 * otherwise the invited user and the link (7 days) in one transaction with the "Invited staff" audit row, then the
 * email (sent after the commit, never stored).
 */
export async function inviteStaff(
  by: StaffActor,
  input: InviteStaffInput,
  opts: { client?: typeof defaultDb; now?: Date } = {},
): Promise<StaffInviteOutcome> {
  const client = opts.client ?? defaultDb;
  const now = opts.now ?? new Date();
  const conflict = inviteConflict(await client.user.findUnique({ where: { email: input.email }, select: { kind: true, staffStatus: true } }));
  if (conflict) throw conflict;
  let created: StaffRecord;
  let email: StaffInviteEmail;
  try {
    ({ user: created, email } = await client.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          kind: "STAFF",
          email: input.email,
          name: "",
          staffRole: input.role,
          staffStatus: "INVITED",
          twoStepEnabled: requiresTwoStep(input.role),
          createdAt: now,
        },
        select: STAFF_SELECT,
      });
      const invite = await issueStaffInvite(tx, { invitee: { id: user.id, email: user.email, role: input.role }, inviter: by.staff, now });
      await audit(tx, by.actor, {
        action: "Invited staff",
        target: user.email,
        targetType: "staff",
        targetId: user.id,
        detail: roleLabel(input.role),
      });
      return { user, email: invite.email };
    }));
  } catch (error) {
    // A concurrent invite or registration took the address between the check and the insert.
    if (isUniqueViolation(error)) {
      throw inviteConflict(await client.user.findUnique({ where: { email: input.email }, select: { kind: true, staffStatus: true } })) ?? error;
    }
    throw error;
  }
  const emailSent = await sendStaffInviteEmail(email);
  log.info("staff_invited", { userId: created.id, role: input.role, by: by.staff.id, emailSent });
  return { staff: await getStaffMember(client, created.id, now), emailSent };
}

async function invitedUser(tx: Tx, id: string): Promise<StaffRecord & { staffRole: StaffRole }> {
  const user = await tx.user.findUnique({ where: { id }, select: STAFF_SELECT });
  if (!user || user.kind !== "STAFF" || !user.staffRole) throw errors.notFound("Staff member");
  if (user.staffStatus !== "INVITED") throw errors.conflict("not_invited", STAFF_ERRORS.notInvited);
  return { ...user, staffRole: user.staffRole };
}

/** POST /api/admin/staff/:id/resend-invite: a fresh 7-day link (older links stop working) and the email again. */
export async function resendStaffInvite(
  by: StaffActor,
  id: string,
  opts: { client?: typeof defaultDb; now?: Date } = {},
): Promise<StaffInviteOutcome> {
  const client = opts.client ?? defaultDb;
  const now = opts.now ?? new Date();
  const email = await client.$transaction(async (tx) => {
    const user = await invitedUser(tx, id);
    const invite = await issueStaffInvite(tx, { invitee: { id: user.id, email: user.email, role: user.staffRole }, inviter: by.staff, now });
    await audit(tx, by.actor, {
      action: "Resent staff invitation",
      target: user.email,
      targetType: "staff",
      targetId: user.id,
      detail: roleLabel(user.staffRole),
    });
    return invite.email;
  });
  const emailSent = await sendStaffInviteEmail(email);
  return { staff: await getStaffMember(client, id, now), emailSent };
}

/**
 * DELETE /api/admin/staff/:id/invite { reason }: removes the invited user (they never signed in), so every link stops
 * working and the address can be invited again or register as a customer. Destructive rule "staff.revoke_invite":
 * a reason (422 `reason_required`) and exactly one audit row "Revoked staff invitation" in the same transaction.
 */
export async function revokeStaffInvite(
  by: StaffActor,
  id: string,
  input: DestructiveInput,
  opts: { client?: typeof defaultDb; now?: Date } = {},
): Promise<{ id: string; email: string }> {
  const client = opts.client ?? defaultDb;
  const now = opts.now ?? new Date();
  const target = await client.user.findUnique({ where: { id }, select: { email: true, kind: true } });
  if (!target || target.kind !== "STAFF") throw errors.notFound("Staff member");
  const revoked = await runDestructive(
    "staff.revoke_invite",
    {
      staff: by.staff,
      actor: by.actor,
      input,
      targetId: id,
      target: target.email,
      targetType: "staff",
      detail: (r: { role: StaffRole }) => roleLabel(r.role),
      client,
    },
    async (tx) => {
      const user = await invitedUser(tx, id);
      await voidStaffInvites(tx, user.id, now);
      const removed = await tx.user.deleteMany({ where: { id: user.id, kind: "STAFF", staffStatus: "INVITED", passwordHash: null } });
      if (removed.count !== 1) throw errors.conflict("staff_changed", STAFF_ERRORS.changed);
      return { id: user.id, email: user.email, role: user.staffRole };
    },
  );
  return { id: revoked.id, email: revoked.email };
}

// ---------- Role and access (destructive, audited) ----------

/**
 * Locks every active Owner row (FOR UPDATE, id order) and returns their ids. A second transaction demoting or
 * deactivating an Owner waits here, then re-reads the rows, so the "at least one active Owner" check cannot be passed
 * twice concurrently.
 */
async function lockActiveOwners(tx: Tx): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User"
    WHERE "kind" = 'STAFF' AND "staffRole" = 'OWNER' AND "staffStatus" = 'ACTIVE'
    ORDER BY "id"
    FOR UPDATE`;
  return rows.map((r) => r.id);
}

async function assertAnotherOwner(tx: Tx, userId: string): Promise<void> {
  const owners = await lockActiveOwners(tx);
  if (!owners.some((id) => id !== userId)) throw errors.conflict("last_owner", STAFF_ERRORS.lastOwner);
}

async function staffForUpdate(tx: Tx, id: string): Promise<StaffRecord & { staffRole: StaffRole }> {
  const user = await tx.user.findUnique({ where: { id }, select: STAFF_SELECT });
  if (!user || user.kind !== "STAFF" || !user.staffRole) throw errors.notFound("Staff member");
  return { ...user, staffRole: user.staffRole };
}

/** The audit target of a staff member: their name, or the email while invited. */
async function staffTarget(client: Db, id: string): Promise<string> {
  const user = await client.user.findUnique({ where: { id }, select: { name: true, email: true, kind: true } });
  if (!user || user.kind !== "STAFF") throw errors.notFound("Staff member");
  return staffDisplayName(user);
}

/**
 * PATCH /api/admin/staff/:id { role, reason }. 409 `own_role`, `role_unchanged`, `last_owner`, `staff_changed`;
 * 422 reason. Owner and Finance get two-step sign-in turned on. The person's sessions are revoked and open sign-in
 * codes voided (sessions carry no two-step marker and the role is read on every request, so a session started under
 * the old role must not carry the new one) and the security epoch bumped (trusted devices need a code again). Audit
 * "Changed staff role", detail "Old → New · signed out of N sessions".
 */
export async function changeStaffRole(
  by: StaffActor,
  id: string,
  input: DestructiveInput & { role: StaffRole },
  opts: { client?: typeof defaultDb; now?: Date } = {},
): Promise<StaffRow> {
  const client = opts.client ?? defaultDb;
  const now = opts.now ?? new Date();
  if (id === by.staff.id) throw errors.conflict("own_role", STAFF_ERRORS.ownRole);
  const target = await staffTarget(client, id);
  await runDestructive(
    "staff.change_role",
    {
      staff: by.staff,
      actor: by.actor,
      input,
      targetId: id,
      target,
      targetType: "staff",
      detail: (r: { from: StaffRole; twoStepOn: boolean; sessions: number }) =>
        `${roleLabel(r.from)} \u2192 ${roleLabel(input.role)}${r.twoStepOn ? " \u00B7 two-step sign-in turned on" : ""}${
          r.sessions > 0 ? ` \u00B7 signed out of ${r.sessions} ${r.sessions === 1 ? "session" : "sessions"}` : ""
        }`,
      client,
    },
    async (tx) => {
      const user = await staffForUpdate(tx, id);
      if (user.staffRole === input.role) throw errors.conflict("role_unchanged", sameRoleMessage(staffDisplayName(user), input.role));
      if (user.staffRole === "OWNER" && user.staffStatus === "ACTIVE") await assertAnotherOwner(tx, id);
      const twoStepOn = requiresTwoStep(input.role) && !user.twoStepEnabled;
      const { count } = await tx.user.updateMany({
        where: { id, kind: "STAFF", staffRole: user.staffRole, staffStatus: user.staffStatus },
        // A new security epoch invalidates their trusted devices (lib/auth/trusted-device.ts).
        data: { staffRole: input.role, securityEpoch: { increment: 1 }, ...(twoStepOn ? { twoStepEnabled: true } : {}) },
      });
      if (count !== 1) throw errors.conflict("staff_changed", STAFF_ERRORS.changed);
      const sessions = await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });
      await tx.authToken.updateMany({ where: { userId: id, usedAt: null, type: "LOGIN_OTP" }, data: { usedAt: now } });
      return { from: user.staffRole, twoStepOn, sessions: sessions.count };
    },
  );
  log.info("staff_role_changed", { userId: id, role: input.role, by: by.staff.id });
  return getStaffMember(client, id);
}

/**
 * POST /api/admin/staff/:id/deactivate { reason }. Only ACTIVE staff (409 `not_active`), never yourself
 * (409 `deactivate_self`), never the last active Owner (409 `last_owner`). Signs them out everywhere and voids their
 * open sign-in, reset and verification codes; bumps the security epoch (trusted devices). Audit "Deactivated staff".
 */
export async function deactivateStaff(
  by: StaffActor,
  id: string,
  input: DestructiveInput,
  opts: { client?: typeof defaultDb; now?: Date } = {},
): Promise<StaffRow> {
  const client = opts.client ?? defaultDb;
  const now = opts.now ?? new Date();
  if (id === by.staff.id) throw errors.conflict("deactivate_self", STAFF_ERRORS.deactivateSelf);
  const target = await staffTarget(client, id);
  await runDestructive(
    "staff.deactivate",
    {
      staff: by.staff,
      actor: by.actor,
      input,
      targetId: id,
      target,
      targetType: "staff",
      detail: (r: { role: StaffRole; sessions: number }) =>
        `${roleLabel(r.role)} \u00B7 signed out of ${r.sessions} ${r.sessions === 1 ? "session" : "sessions"}`,
      client,
    },
    async (tx) => {
      const user = await staffForUpdate(tx, id);
      if (user.staffStatus !== "ACTIVE") throw errors.conflict("not_active", STAFF_ERRORS.notActive);
      if (user.staffRole === "OWNER") await assertAnotherOwner(tx, id);
      const { count } = await tx.user.updateMany({
        where: { id, kind: "STAFF", staffStatus: "ACTIVE", staffRole: user.staffRole },
        data: { staffStatus: "DEACTIVATED", securityEpoch: { increment: 1 } },
      });
      if (count !== 1) throw errors.conflict("staff_changed", STAFF_ERRORS.changed);
      const sessions = await tx.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: now } });
      await tx.authToken.updateMany({
        where: { userId: id, usedAt: null, type: { in: ["LOGIN_OTP", "PASSWORD_RESET", "EMAIL_VERIFY"] } },
        data: { usedAt: now },
      });
      return { role: user.staffRole, sessions: sessions.count };
    },
  );
  log.info("staff_deactivated", { userId: id, by: by.staff.id });
  return getStaffMember(client, id, now);
}

/**
 * POST /api/admin/staff/:id/reactivate { reason }. Only DEACTIVATED staff (409 `not_deactivated`); they sign in again
 * with their existing password (two-step on for Owner and Finance) and a code on every device: the security epoch is
 * bumped again. Audit "Reactivated staff".
 */
export async function reactivateStaff(
  by: StaffActor,
  id: string,
  input: DestructiveInput,
  opts: { client?: typeof defaultDb } = {},
): Promise<StaffRow> {
  const client = opts.client ?? defaultDb;
  if (id === by.staff.id) throw errors.conflict("not_deactivated", STAFF_ERRORS.notDeactivated);
  const target = await staffTarget(client, id);
  await runDestructive(
    "staff.reactivate",
    { staff: by.staff, actor: by.actor, input, targetId: id, target, targetType: "staff", detail: (role: StaffRole) => roleLabel(role), client },
    async (tx) => {
      const user = await staffForUpdate(tx, id);
      if (user.staffStatus !== "DEACTIVATED") throw errors.conflict("not_deactivated", STAFF_ERRORS.notDeactivated);
      const { count } = await tx.user.updateMany({
        where: { id, kind: "STAFF", staffStatus: "DEACTIVATED", staffRole: user.staffRole },
        // Bumped again on reactivation, so no trusted device from before the deactivation skips the code.
        data: { staffStatus: "ACTIVE", securityEpoch: { increment: 1 }, ...(requiresTwoStep(user.staffRole) ? { twoStepEnabled: true } : {}) },
      });
      if (count !== 1) throw errors.conflict("staff_changed", STAFF_ERRORS.changed);
      return user.staffRole;
    },
  );
  return getStaffMember(client, id);
}
