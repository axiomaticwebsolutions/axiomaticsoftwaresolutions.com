/**
 * Staff & roles service (lib/admin/staff/service.ts, invites.ts): invitations (STAFF user INVITED, hashed 7-day
 * STAFF_INVITE token with { staffRole, invitedById }, staff_invite email sent directly and never stored, audit),
 * conflicts (customer emails,
 * existing, invited and deactivated staff), resend and revoke; role changes, deactivation and reactivation through
 * runDestructive (reason, exactly one audit row, not yourself, at least one active Owner, two-step left as each person
 * set it for every role, sessions revoked on deactivation), including two concurrent demotions of the last two Owners.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StaffRole, User } from "@/generated/prisma/client";
import { actorFromStaff } from "@/lib/audit";
import { changeStaffRole, deactivateStaff, inviteStaff, reactivateStaff, resendStaffInvite, revokeStaffInvite } from "@/lib/admin/staff/service";
import type { StaffActor } from "@/lib/admin/staff/service";
import { createSession, resolveSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { setEmailTransport, type OutgoingEmail } from "@/lib/email";
import { ApiError } from "@/lib/http";
import { makeCustomer, makeStaff } from "../support/admin-fixtures";

const sent: OutgoingEmail[] = [];
beforeAll(() => {
  setEmailTransport({ name: "test", send: async (mail) => (sent.push(mail), { messageId: `m${sent.length}` }) });
});
afterAll(() => setEmailTransport(null));
const sentTo = (address: string) => sent.filter((m) => m.to === address && m.templateId === "staff_invite");

const tag = () => randomBytes(4).toString("hex");
const email = (label: string) => `m7-${label}.${tag()}@axiomatic.test`;

function actorOf(user: User): StaffActor {
  if (!user.staffRole) throw new Error("staff only");
  return { staff: { id: user.id, name: user.name, role: user.staffRole }, actor: actorFromStaff(user, "103.21.44.x") };
}

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected an ApiError");
}

const auditRows = (targetId: string) => db.auditLog.findMany({ where: { targetId }, orderBy: { createdAt: "asc" } });

/**
 * Runs `fn` while the given users are the only ACTIVE Owners (others are set DEACTIVATED and restored afterwards; DB
 * test files run one at a time, so no other file sees the change).
 */
async function withOnlyOwners<T>(keep: readonly string[], fn: () => Promise<T>): Promise<T> {
  const others = await db.user.findMany({
    where: { kind: "STAFF", staffRole: "OWNER", staffStatus: "ACTIVE", id: { notIn: [...keep] } },
    select: { id: true },
  });
  const ids = others.map((o) => o.id);
  await db.user.updateMany({ where: { id: { in: ids } }, data: { staffStatus: "DEACTIVATED" } });
  try {
    return await fn();
  } finally {
    await db.user.updateMany({ where: { id: { in: ids } }, data: { staffStatus: "ACTIVE" } });
  }
}

describe("inviteStaff", () => {
  it("creates an invited staff user, a hashed 7-day link, the email and one audit row", async () => {
    const owner = await makeStaff("OWNER");
    const address = email("invite");
    const now = new Date("2026-10-07T06:00:00.000Z");
    const { staff: row, emailSent } = await inviteStaff(actorOf(owner), { email: address, role: "SUPPORT" }, { now });
    expect(emailSent).toBe(true);
    expect(row).toMatchObject({ email: address, role: "SUPPORT", status: "invited", name: "", twoStepEnabled: false });
    expect(row.invite).toEqual({ sentAt: now.toISOString(), expiresAt: "2026-10-14T06:00:00.000Z", expired: false });

    const user = await db.user.findUniqueOrThrow({ where: { id: row.id } });
    expect(user).toMatchObject({ kind: "STAFF", staffStatus: "INVITED", passwordHash: null, emailVerifiedAt: null });
    const token = await db.authToken.findFirstOrThrow({ where: { userId: row.id, type: "STAFF_INVITE" } });
    expect(token.meta).toEqual({ staffRole: "SUPPORT", invitedById: owner.id });
    expect(token.codeHash).toMatch(/^[0-9a-f]{64}$/);

    // The email holds the link: sent directly after the commit, never stored in the outbox.
    expect(await db.outboxEmail.count({ where: { to: address } })).toBe(0);
    const [mail] = sentTo(address);
    if (!mail) throw new Error("no invitation email sent");
    const link = /\/staff-invite\?token=([A-Za-z0-9._%-]+)/.exec(mail.text)?.[1];
    expect(link && decodeURIComponent(link).startsWith(`${token.id}.`)).toBe(true);
    expect(mail.text).toContain("Support");

    const rows = await auditRows(row.id);
    expect(rows.map((r) => [r.action, r.target, r.targetType, r.detail, r.actorId, r.actorRole])).toEqual([
      ["Invited staff", address, "staff", "Support", owner.id, "owner"],
    ]);
  });

  it("leaves two-step sign-in off for every invited role, Owner and Finance included", async () => {
    const owner = await makeStaff("OWNER");
    for (const role of ["OWNER", "FINANCE", "ADMIN", "SUPPORT"] as StaffRole[]) {
      const { staff: row } = await inviteStaff(actorOf(owner), { email: email(`twostep-${role}`), role });
      expect(row.twoStepEnabled, role).toBe(false);
      expect((await db.user.findUniqueOrThrow({ where: { id: row.id } })).twoStepEnabled, role).toBe(false);
    }
  });

  it("refuses customer emails, staff, pending invitations and deactivated staff", async () => {
    const owner = await makeStaff("OWNER");
    const { user: customer } = await makeCustomer();
    const active = await makeStaff("SUPPORT");
    const deactivated = await makeStaff("ADMIN", { status: "DEACTIVATED" });
    const { staff: invited } = await inviteStaff(actorOf(owner), { email: email("pending"), role: "FINANCE" });
    const cases: [string, string][] = [
      [customer.email, "customer_email"],
      [active.email, "already_staff"],
      [invited.email, "already_invited"],
      [deactivated.email, "staff_deactivated"],
    ];
    for (const [address, code] of cases) {
      const error = await apiError(inviteStaff(actorOf(owner), { email: address, role: "SUPPORT" }));
      expect([error.status, error.code], address).toEqual([409, code]);
    }
    expect((await apiError(inviteStaff(actorOf(owner), { email: customer.email, role: "SUPPORT" }))).message).toMatch(/customer account/);
  });
});

describe("resend and revoke invitations", () => {
  it("resending voids the older link and emails a new one; revoking removes the pending record", async () => {
    const owner = await makeStaff("OWNER");
    const { staff: invited } = await inviteStaff(actorOf(owner), { email: email("resend"), role: "SUPPORT" });
    const first = await db.authToken.findFirstOrThrow({ where: { userId: invited.id, type: "STAFF_INVITE" } });
    expect((await resendStaffInvite(actorOf(owner), invited.id)).emailSent).toBe(true);
    const tokens = await db.authToken.findMany({ where: { userId: invited.id, type: "STAFF_INVITE" }, orderBy: { createdAt: "asc" } });
    expect(tokens).toHaveLength(2);
    expect(tokens.find((t) => t.id === first.id)?.usedAt).not.toBeNull();
    expect(tokens.filter((t) => t.usedAt === null)).toHaveLength(1);
    expect(sentTo(invited.email)).toHaveLength(2);
    expect(await db.outboxEmail.count({ where: { to: invited.email } })).toBe(0);

    const noReason = await apiError(revokeStaffInvite(actorOf(owner), invited.id, {}));
    expect([noReason.status, noReason.code]).toEqual([422, "reason_required"]);
    expect(await db.user.findUnique({ where: { id: invited.id } })).not.toBeNull();
    const revoked = await revokeStaffInvite(actorOf(owner), invited.id, { reason: "Hired someone else" });
    expect(revoked).toEqual({ id: invited.id, email: invited.email });
    expect(await db.user.findUnique({ where: { id: invited.id } })).toBeNull();
    expect((await auditRows(invited.id)).map((r) => r.action)).toEqual(["Invited staff", "Resent staff invitation", "Revoked staff invitation"]);
    expect((await auditRows(invited.id)).at(-1)).toMatchObject({ reason: "Hired someone else", detail: "Support" });
  });

  it("refuses resend and revoke once the person is active", async () => {
    const owner = await makeStaff("OWNER");
    const active = await makeStaff("SUPPORT");
    for (const promise of [resendStaffInvite(actorOf(owner), active.id), revokeStaffInvite(actorOf(owner), active.id, { reason: "Not needed" })]) {
      const error = await apiError(promise);
      expect([error.status, error.code]).toEqual([409, "not_invited"]);
    }
    expect(await db.user.findUnique({ where: { id: active.id } })).not.toBeNull();
  });
});

describe("changeStaffRole", () => {
  it("needs a reason, then changes the role with exactly one audit row (two-step stays as it was)", async () => {
    const owner = await makeStaff("OWNER");
    const support = await db.user.update({ where: { id: (await makeStaff("SUPPORT")).id }, data: { twoStepEnabled: false } });
    // A password-only session from before the change must not carry the new role (no two-step was passed).
    const before = await createSession(db, { userId: support.id, kind: "STAFF" });
    await db.authToken.create({
      data: { type: "LOGIN_OTP", userId: support.id, email: support.email, codeHash: "y".repeat(64), expiresAt: new Date(Date.now() + 600_000) },
    });
    const missing = await apiError(changeStaffRole(actorOf(owner), support.id, { role: "FINANCE", reason: "  " }));
    expect([missing.status, missing.code]).toEqual([422, "reason_required"]);
    expect(await auditRows(support.id)).toHaveLength(0);

    const row = await changeStaffRole(actorOf(owner), support.id, { role: "FINANCE", reason: "Moved to accounts" });
    expect(row).toMatchObject({ role: "FINANCE", twoStepEnabled: false });
    const rows = await auditRows(support.id);
    expect(rows.map((r) => [r.action, r.reason, r.detail])).toEqual([
      ["Changed staff role", "Moved to accounts", "Support \u2192 Finance \u00B7 signed out of 1 session"],
    ]);
    expect(await resolveSession(db, before.token)).toBeNull();
    expect(await db.authToken.count({ where: { userId: support.id, type: "LOGIN_OTP", usedAt: null } })).toBe(0);
    const same = await apiError(changeStaffRole(actorOf(owner), support.id, { role: "FINANCE", reason: "Again please" }));
    expect([same.status, same.code]).toEqual([409, "role_unchanged"]);
    expect(await auditRows(support.id)).toHaveLength(1);
  });

  it("keeps a two-step setting that is on through role changes and reactivation", async () => {
    const owner = await makeStaff("OWNER");
    const finance = await makeStaff("FINANCE", { twoStep: true });
    expect((await changeStaffRole(actorOf(owner), finance.id, { role: "SUPPORT", reason: "Moved to support" })).twoStepEnabled).toBe(true);
    await deactivateStaff(actorOf(owner), finance.id, { reason: "Long leave" });
    expect((await reactivateStaff(actorOf(owner), finance.id, { reason: "Back from leave" })).twoStepEnabled).toBe(true);
    const offFinance = await makeStaff("FINANCE");
    await deactivateStaff(actorOf(owner), offFinance.id, { reason: "Long leave" });
    const back = await reactivateStaff(actorOf(owner), offFinance.id, { reason: "Back from leave" });
    expect([back.role, back.twoStepEnabled]).toEqual(["FINANCE", false]);
  });

  it("never changes your own role", async () => {
    const owner = await makeStaff("OWNER");
    const error = await apiError(changeStaffRole(actorOf(owner), owner.id, { role: "ADMIN", reason: "Stepping down" }));
    expect([error.status, error.code]).toEqual([409, "own_role"]);
  });

  it("keeps at least one active Owner", async () => {
    const actor = await makeStaff("OWNER");
    const lastOwner = await makeStaff("OWNER");
    const error = await withOnlyOwners([lastOwner.id], () =>
      apiError(changeStaffRole(actorOf(actor), lastOwner.id, { role: "ADMIN", reason: "Reorganising" })),
    );
    expect([error.status, error.code]).toEqual([409, "last_owner"]);
    expect((await db.user.findUniqueOrThrow({ where: { id: lastOwner.id } })).staffRole).toBe("OWNER");
    expect(await auditRows(lastOwner.id)).toHaveLength(0);
  });

  it("lets only one of two concurrent demotions of the last two Owners through", async () => {
    const actor = await makeStaff("OWNER");
    const a = await makeStaff("OWNER");
    const b = await makeStaff("OWNER");
    const results = await withOnlyOwners([a.id, b.id], () =>
      Promise.allSettled([
        changeStaffRole(actorOf(actor), a.id, { role: "ADMIN", reason: "Concurrent one" }),
        changeStaffRole(actorOf(actor), b.id, { role: "ADMIN", reason: "Concurrent two" }),
      ]),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected");
    expect(rejected && rejected.status === "rejected" && rejected.reason instanceof ApiError ? rejected.reason.code : null).toBe("last_owner");
    const roles = await db.user.findMany({ where: { id: { in: [a.id, b.id] } }, select: { staffRole: true } });
    expect(roles.map((r) => r.staffRole).sort()).toEqual(["ADMIN", "OWNER"]);
  });
});

describe("deactivateStaff and reactivateStaff", () => {
  it("signs them out everywhere, voids open codes and writes one audit row; reactivation restores access", async () => {
    const owner = await makeStaff("OWNER");
    const target = await makeStaff("SUPPORT");
    const one = await createSession(db, { userId: target.id, kind: "STAFF" });
    const two = await createSession(db, { userId: target.id, kind: "STAFF" });
    await db.authToken.create({
      data: { type: "PASSWORD_RESET", userId: target.id, email: target.email, codeHash: "x".repeat(64), expiresAt: new Date(Date.now() + 600_000) },
    });

    const missing = await apiError(deactivateStaff(actorOf(owner), target.id, {}));
    expect([missing.status, missing.code]).toEqual([422, "reason_required"]);
    expect((await db.user.findUniqueOrThrow({ where: { id: target.id } })).staffStatus).toBe("ACTIVE");

    const row = await deactivateStaff(actorOf(owner), target.id, { reason: "Left the company" });
    expect(row.status).toBe("deactivated");
    expect(await resolveSession(db, one.token)).toBeNull();
    expect(await resolveSession(db, two.token)).toBeNull();
    expect(await db.session.count({ where: { userId: target.id, revokedAt: null } })).toBe(0);
    expect(await db.authToken.count({ where: { userId: target.id, usedAt: null } })).toBe(0);
    const rows = await auditRows(target.id);
    expect(rows.map((r) => [r.action, r.reason, r.detail])).toEqual([["Deactivated staff", "Left the company", "Support \u00B7 signed out of 2 sessions"]]);

    const again = await apiError(deactivateStaff(actorOf(owner), target.id, { reason: "Twice over" }));
    expect([again.status, again.code]).toEqual([409, "not_active"]);

    const back = await reactivateStaff(actorOf(owner), target.id, { reason: "Rejoined the team" });
    expect(back.status).toBe("active");
    expect((await auditRows(target.id)).map((r) => r.action)).toEqual(["Deactivated staff", "Reactivated staff"]);
    const notDeactivated = await apiError(reactivateStaff(actorOf(owner), target.id, { reason: "Once more" }));
    expect([notDeactivated.status, notDeactivated.code]).toEqual([409, "not_deactivated"]);
  });

  it("never deactivates yourself, a pending invitation or the last active Owner", async () => {
    const owner = await makeStaff("OWNER");
    const self = await apiError(deactivateStaff(actorOf(owner), owner.id, { reason: "Leaving now" }));
    expect([self.status, self.code]).toEqual([409, "deactivate_self"]);

    const { staff: invited } = await inviteStaff(actorOf(owner), { email: email("deact-invited"), role: "SUPPORT" });
    const pending = await apiError(deactivateStaff(actorOf(owner), invited.id, { reason: "Not needed" }));
    expect([pending.status, pending.code]).toEqual([409, "not_active"]);

    const lastOwner = await makeStaff("OWNER");
    const last = await withOnlyOwners([lastOwner.id], () => apiError(deactivateStaff(actorOf(owner), lastOwner.id, { reason: "Locking out" })));
    expect([last.status, last.code]).toEqual([409, "last_owner"]);
    expect((await db.user.findUniqueOrThrow({ where: { id: lastOwner.id } })).staffStatus).toBe("ACTIVE");
  });

  it("answers 404 for customers and unknown ids", async () => {
    const owner = await makeStaff("OWNER");
    const { user: customer } = await makeCustomer();
    for (const id of [customer.id, "missing-staff-id"]) {
      const error = await apiError(deactivateStaff(actorOf(owner), id, { reason: "Not staff" }));
      expect(error.status, id).toBe(404);
    }
  });
});
