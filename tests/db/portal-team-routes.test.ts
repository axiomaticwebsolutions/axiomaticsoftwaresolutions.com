/**
 * "Team & access" routes: Owner-only access, invitations (placeholder users, hashed tokens, outbox email, duplicates),
 * role changes (not your own; Owner only for members who joined; concurrent demotions keep an owner), removal
 * (sessions forget the account; not yourself), revoking and resending invitations, activity entries with the actor,
 * and account scoping (IDOR).
 */
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as accountLicensesGET } from "@/app/api/account/licenses/route";
import { POST as resendPOST } from "@/app/api/account/team/[memberId]/resend/route";
import { DELETE as memberDELETE, PATCH as memberPATCH } from "@/app/api/account/team/[memberId]/route";
import { GET as teamGET, POST as teamPOST } from "@/app/api/account/team/route";
import { createSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { setEmailTransport, type OutgoingEmail } from "@/lib/email";
import { getEnv } from "@/lib/env";
import { changeMemberRole } from "@/lib/portal/team";
import { uniqueEmail } from "./auth-fixtures";
import { bodyOf, call, errorOf, makeMember, signIn, type Member } from "./license-actions-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string, options: { maxAge?: number } = {}) => {
      if (options.maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
  headers: async () => new Headers(),
}));

// The team_invite email is sent directly (never stored); this transport captures it.
const sent: OutgoingEmail[] = [];
beforeAll(() => {
  setEmailTransport({ name: "test", send: async (mail) => (sent.push(mail), { messageId: `m${sent.length}` }) });
});
afterAll(() => setEmailTransport(null));
const invitesTo = (email: string) => sent.filter((m) => m.to === email && m.templateId === "team_invite");

let owner: Member;
beforeEach(async () => {
  owner = await makeMember({ name: "Priya Sharma" });
  await signIn(jar, owner);
});

type MemberView = { id: string; userId: string; name: string; email: string; role: string; status: string; you: boolean; inviteExpired: boolean };
const team = () => call(jar, teamGET, "/api/account/team");
const invite = (email: string, role?: string) => call(jar, teamPOST, "/api/account/team", { method: "POST", body: role ? { email, role } : { email } });
const patch = (memberId: string, role: string) =>
  call(jar, memberPATCH, `/api/account/team/${memberId}`, { method: "PATCH", body: { role }, params: { memberId } });
const remove = (memberId: string) => call(jar, memberDELETE, `/api/account/team/${memberId}`, { method: "DELETE", params: { memberId } });
const resend = (memberId: string) => call(jar, resendPOST, `/api/account/team/${memberId}/resend`, { method: "POST", params: { memberId } });
const memberIdOf = async (m: Member) =>
  (await db.accountMember.findUniqueOrThrow({ where: { accountId_userId: { accountId: m.accountId, userId: m.user.id } } })).id;

describe("access", () => {
  it("is Owner only", async () => {
    for (const role of ["BILLING", "TECHNICAL", "VIEWER"] as const) {
      const m = await makeMember({ accountId: owner.accountId, role });
      await signIn(jar, m);
      const res = await team();
      expect(res.status, role).toBe(403);
      expect((await invite(uniqueEmail("x"))).status, role).toBe(403);
      expect((await patch(await memberIdOf(owner), "VIEWER")).status, role).toBe(403);
    }
  });

  it("lists active members first with 'you', then pending invitations", async () => {
    const billing = await makeMember({ accountId: owner.accountId, role: "BILLING", name: "Rohan Sharma" });
    const email = uniqueEmail("accounts");
    expect((await invite(email, "VIEWER")).status).toBe(201);
    const body = (await (await team()).json()) as { members: MemberView[]; counts: { active: number; invited: number } };
    expect(body.counts).toEqual({ active: 2, invited: 1 });
    expect(body.members.map((m) => [m.email, m.role, m.status, m.you])).toEqual([
      [owner.user.email, "OWNER", "active", true],
      [billing.user.email, "BILLING", "active", false],
      [email, "VIEWER", "invited", false],
    ]);
    expect(body.members[2]).toMatchObject({ name: "", inviteExpired: false });
  });
});

describe("invite", () => {
  it("creates a placeholder user, an INVITED membership, a hashed 7-day token, the email and the activity entry", async () => {
    const email = uniqueEmail("Accounts").toUpperCase();
    const res = await invite(`  ${email} `, "VIEWER");
    expect(res.status).toBe(201);
    const lower = email.toLowerCase();
    const user = await db.user.findUniqueOrThrow({ where: { email: lower } });
    expect(user).toMatchObject({ kind: "CUSTOMER", name: "", passwordHash: null, emailVerifiedAt: null });
    const member = await db.accountMember.findUniqueOrThrow({ where: { accountId_userId: { accountId: owner.accountId, userId: user.id } } });
    expect(member).toMatchObject({ role: "VIEWER", status: "INVITED" });
    const tokens = await db.authToken.findMany({ where: { userId: user.id, type: "TEAM_INVITE" } });
    expect(tokens).toHaveLength(1);
    const token = tokens[0]!;
    expect(token.meta).toEqual({ accountId: owner.accountId, role: "VIEWER", invitedById: owner.user.id });
    expect(token.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token.expiresAt.getTime() - Date.now()).toBeGreaterThan(6.99 * 86_400_000);
    expect(((await res.json()) as { emailSent: boolean }).emailSent).toBe(true);
    // The email holds the link: sent directly after the commit and never stored in the outbox.
    expect(await db.outboxEmail.count({ where: { to: lower } })).toBe(0);
    const [mail] = invitesTo(lower);
    if (!mail) throw new Error("no invitation email sent");
    expect(mail.text).toContain(`token=${encodeURIComponent(token.id)}.`);
    expect(mail.subject).toContain("Priya Sharma invited you to");
    expect(mail.text).toMatch(/\/invite\?token=/);
    expect(mail.text).toContain("as Viewer");
    const activity = await db.accountActivity.findFirstOrThrow({ where: { accountId: owner.accountId, action: "Invited team member" } });
    expect(activity).toMatchObject({ actorId: owner.user.id, actorName: "Priya Sharma", target: `${lower} \u00B7 Viewer`, kind: "team" });
  });

  it("invites an existing customer without touching their user, and refuses duplicates", async () => {
    const other = await makeMember({ name: "Kavya Desai" });
    expect((await invite(other.user.email, "TECHNICAL")).status).toBe(201);
    expect(await db.user.findUniqueOrThrow({ where: { id: other.user.id } })).toMatchObject({ name: "Kavya Desai", passwordHash: other.user.passwordHash });
    for (const email of [other.user.email, other.user.email.toUpperCase(), owner.user.email]) {
      const res = await invite(email);
      expect(res.status, email).toBe(409);
      const error = errorOf(await bodyOf(res));
      expect(error).toMatchObject({ code: "already_member", message: "This person is already on your team." });
      expect(error.fieldErrors).toEqual({ email: ["This person is already on your team."] });
    }
  });

  it("refuses the Owner role, staff addresses and invalid emails (422)", async () => {
    expect((await invite(uniqueEmail("x"), "OWNER")).status).toBe(422);
    const staff = await db.user.create({ data: { email: uniqueEmail("staff"), name: "Sneha", kind: "STAFF", staffRole: "SUPPORT", staffStatus: "ACTIVE" } });
    const res = await invite(staff.email);
    expect(res.status).toBe(422);
    expect(errorOf(await bodyOf(res)).fieldErrors).toEqual({ email: ["This email address can’t be invited. Use a different one."] });
    expect((await invite("not-an-email")).status).toBe(422);
  });

  it("resends with a fresh link and voids the old one; joined members cannot be re-sent", async () => {
    const email = uniqueEmail("resend");
    const created = (await (await invite(email)).json()) as { member: MemberView };
    const first = await db.authToken.findFirstOrThrow({ where: { email, type: "TEAM_INVITE" } });
    const res = await resend(created.member.id);
    expect(res.status).toBe(200);
    const tokens = await db.authToken.findMany({ where: { email, type: "TEAM_INVITE" }, orderBy: { createdAt: "asc" } });
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.id).toBe(first.id);
    expect(tokens[0]?.usedAt).not.toBeNull();
    expect(tokens[1]?.usedAt).toBeNull();
    expect(invitesTo(email)).toHaveLength(2);
    expect(await db.outboxEmail.count({ where: { to: email, templateId: "team_invite" } })).toBe(0);
    const joined = await makeMember({ accountId: owner.accountId, role: "BILLING" });
    const notInvited = await resend(await memberIdOf(joined));
    expect(notInvited.status).toBe(409);
    expect(errorOf(await bodyOf(notInvited)).code).toBe("not_invited");
  });
});

describe("role changes", () => {
  it("changes another member's role at once and logs it; the same role is a no-op", async () => {
    const rohan = await makeMember({ accountId: owner.accountId, role: "BILLING", name: "Rohan Sharma" });
    const id = await memberIdOf(rohan);
    const res = await patch(id, "TECHNICAL");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { member: MemberView }).member).toMatchObject({ role: "TECHNICAL", status: "active" });
    expect((await patch(id, "TECHNICAL")).status).toBe(200);
    const entries = await db.accountActivity.findMany({ where: { accountId: owner.accountId, action: "Changed role" } });
    expect(entries.map((e) => [e.target, e.actorId])).toEqual([["Rohan Sharma \u2192 Technical contact", owner.user.id]]);
    // Applies to the member's next request.
    await signIn(jar, rohan);
    expect((await call(jar, accountLicensesGET, "/api/account/licenses")).status).toBe(200);
  });

  it("refuses your own role, and Owner for someone who has not joined", async () => {
    const own = await patch(await memberIdOf(owner), "VIEWER");
    expect(own.status).toBe(403);
    expect(errorOf(await bodyOf(own))).toMatchObject({ code: "own_role", message: "You can’t change your own role." });
    const pending = (await (await invite(uniqueEmail("p"))).json()) as { member: MemberView };
    expect((await patch(pending.member.id, "OWNER")).status).toBe(422);
    expect((await patch(pending.member.id, "VIEWER")).status).toBe(200);
  });

  it("lets an owner make another member an owner, and two owners demoting each other at once keep one owner", async () => {
    const second = await makeMember({ accountId: owner.accountId, role: "TECHNICAL", name: "Kavya Desai" });
    expect((await patch(await memberIdOf(second), "OWNER")).status).toBe(200);
    const actor = (m: Member) => ({ id: m.user.id, name: m.user.name, email: m.user.email });
    const results = await Promise.allSettled([
      changeMemberRole({ accountId: owner.accountId, actor: actor(owner), memberId: await memberIdOf(second), role: "VIEWER" }),
      changeMemberRole({ accountId: owner.accountId, actor: actor(second), memberId: await memberIdOf(owner), role: "VIEWER" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const owners = await db.accountMember.count({ where: { accountId: owner.accountId, role: "OWNER", status: "ACTIVE" } });
    expect(owners).toBe(1);
  });
});

describe("remove and revoke", () => {
  it("removes a member: their sessions forget the account and they lose access at once", async () => {
    const kavya = await makeMember({ accountId: owner.accountId, role: "TECHNICAL", name: "Kavya Desai" });
    const { session } = await createSession(db, { userId: kavya.user.id, kind: "CUSTOMER", activeAccountId: owner.accountId });
    const res = await remove(await memberIdOf(kavya));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: "member" });
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).activeAccountId).toBeNull();
    expect(await db.accountMember.count({ where: { accountId: owner.accountId, userId: kavya.user.id } })).toBe(0);
    const entry = await db.accountActivity.findFirstOrThrow({ where: { accountId: owner.accountId, action: "Removed team member" } });
    expect(entry).toMatchObject({ target: "Kavya Desai", actorId: owner.user.id });
    await signIn(jar, kavya);
    const after = await call(jar, accountLicensesGET, "/api/account/licenses");
    expect(after.status).toBe(403);
    expect(errorOf(await bodyOf(after)).code).toBe("no_account");
  });

  it("never removes yourself", async () => {
    const res = await remove(await memberIdOf(owner));
    expect(res.status).toBe(403);
    expect(errorOf(await bodyOf(res))).toMatchObject({ code: "remove_self", message: "You can’t remove yourself." });
  });

  it("revokes an invitation: links voided, placeholder user dropped, 'Revoked invite' logged", async () => {
    const email = uniqueEmail("revoke");
    const created = (await (await invite(email)).json()) as { member: MemberView };
    const res = await remove(created.member.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ removed: "invite" });
    expect(await db.user.findUnique({ where: { email } })).toBeNull();
    expect(await db.authToken.count({ where: { email, type: "TEAM_INVITE" } })).toBe(0);
    const entry = await db.accountActivity.findFirstOrThrow({ where: { accountId: owner.accountId, action: "Revoked invite" } });
    expect(entry.target).toBe(email);
  });

  it("keeps an invited user who has an account, and voids their link", async () => {
    const other = await makeMember({ name: "Asha Rao" });
    const created = (await (await invite(other.user.email)).json()) as { member: MemberView };
    expect((await remove(created.member.id)).status).toBe(200);
    expect(await db.user.findUnique({ where: { id: other.user.id } })).not.toBeNull();
    const tokens = await db.authToken.findMany({ where: { userId: other.user.id, type: "TEAM_INVITE" } });
    expect(tokens.every((t) => t.usedAt !== null)).toBe(true);
  });

  it("answers 404 for members of another account", async () => {
    const stranger = await makeMember();
    const strangerMember = await memberIdOf(stranger);
    for (const res of [await patch(strangerMember, "VIEWER"), await remove(strangerMember), await resend(strangerMember)]) {
      expect(res.status).toBe(404);
    }
    expect((await db.accountMember.findUniqueOrThrow({ where: { id: strangerMember } })).role).toBe("OWNER");
  });
});

describe("browser-style requests", () => {
  it("accepts a DELETE whose body is an empty stream without Content-Type or Content-Length", async () => {
    const pending = (await (await invite(uniqueEmail("stream"))).json()) as { member: MemberView };
    const appUrl = getEnv().APP_URL;
    const headers = new Headers({ origin: new URL(appUrl).origin, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") });
    headers.set("x-csrf-token", jar.get("axs_csrf") ?? "");
    const empty = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    const init = { method: "DELETE", headers, body: empty, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1];
    const req = new NextRequest(`${appUrl}/api/account/team/${pending.member.id}`, init);
    const res = await memberDELETE(req, { params: Promise.resolve({ memberId: pending.member.id }) });
    expect(res.status).toBe(200);
    const junk = new NextRequest(`${appUrl}/api/account/team/x`, { method: "DELETE", headers, body: "not json" });
    expect((await memberDELETE(junk, { params: Promise.resolve({ memberId: "x" }) })).status).toBe(415);
  });
});
