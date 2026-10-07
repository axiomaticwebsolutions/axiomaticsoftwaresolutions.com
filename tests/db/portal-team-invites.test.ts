/**
 * Invitation links: preview (account, role, whether the person has an account), acceptance by a new person (name +
 * password policy, email verified, signed in with the account active) or by an existing customer (must be signed in
 * as that email), single use, expiry, revocation and replacement by a resend, CSRF.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as acceptPOST } from "@/app/api/invites/accept/route";
import { GET as previewGET } from "@/app/api/invites/[token]/route";
import { POST as resendPOST } from "@/app/api/account/team/[memberId]/resend/route";
import { DELETE as memberDELETE, PATCH as memberPATCH } from "@/app/api/account/team/[memberId]/route";
import { POST as teamPOST } from "@/app/api/account/team/route";
import { ANON_CSRF_BINDING, issueCsrfToken } from "@/lib/auth/csrf";
import { clear, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { resolveSession } from "@/lib/auth/sessions";
import { verifyPassword } from "@/lib/auth/password";
import { db } from "@/lib/db";
import { setEmailTransport, type OutgoingEmail } from "@/lib/email";
import { getEnv } from "@/lib/env";
import { uniqueEmail } from "./auth-fixtures";
import { bodyOf, call, errorOf, makeMember, PASSWORD, signIn, type Member } from "./license-actions-fixtures";

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

const NEW_PASSWORD = "Joined2team";
let owner: Member;

beforeEach(async () => {
  await clear(db, RATE_LIMITS.inviteAcceptIp(null).key);
  await clear(db, RATE_LIMITS.invitePreviewIp(null).key);
  owner = await makeMember({ name: "Priya Sharma" });
  await signIn(jar, owner);
});

type Invited = { memberId: string; token: string; email: string };

// The team_invite email is sent directly (never stored); this transport captures it.
const sent: OutgoingEmail[] = [];
beforeAll(() => {
  setEmailTransport({ name: "test", send: async (mail) => (sent.push(mail), { messageId: `m${sent.length}` }) });
});
afterAll(() => setEmailTransport(null));

/** Invites as the owner and reads the link from the email sent (the only place the secret exists). */
async function inviteAs(email: string, role = "TECHNICAL"): Promise<Invited> {
  await signIn(jar, owner);
  const res = await call(jar, teamPOST, "/api/account/team", { method: "POST", body: { email, role } });
  expect(res.status).toBe(201);
  const memberId = ((await res.json()) as { member: { id: string } }).member.id;
  return { memberId, token: await latestToken(email), email };
}

async function latestToken(email: string): Promise<string> {
  const mail = sent.filter((m) => m.to === email && m.templateId === "team_invite").at(-1);
  if (!mail) throw new Error("no invitation email sent");
  expect(await db.outboxEmail.count({ where: { to: email, templateId: "team_invite" } })).toBe(0);
  const match = /\/invite\?token=([A-Za-z0-9._%-]+)/.exec(mail.text);
  if (!match?.[1]) throw new Error("no invite link in the email");
  return decodeURIComponent(match[1]);
}

/** Visitor without a session (anonymous CSRF token, as GET /api/csrf would issue). */
async function signOut(): Promise<void> {
  jar.clear();
  jar.set("axs_csrf", issueCsrfToken(ANON_CSRF_BINDING, getEnv().CSRF_SECRET));
}

const preview = (token: string) => call(jar, previewGET, `/api/invites/${encodeURIComponent(token)}`, { params: { token } });
const accept = (body: Record<string, unknown>, opts: { csrf?: boolean } = {}) =>
  call(jar, acceptPOST, "/api/invites/accept", { method: "POST", body, ...opts });

describe("preview", () => {
  it("shows the account, role and whether the person already has an account", async () => {
    const fresh = await inviteAs(uniqueEmail("new"), "VIEWER");
    await signOut();
    const res = await preview(fresh.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const { invite } = (await res.json()) as { invite: Record<string, unknown> };
    expect(invite).toMatchObject({
      email: fresh.email,
      role: "VIEWER",
      roleLabel: "Viewer",
      inviterName: "Priya Sharma",
      accountExists: false,
      viewer: { signedIn: false, isInvitee: false },
    });
    expect(String(invite.accountName)).toContain("Sharma Medicals");

    const existing = await makeMember({ name: "Asha Rao" });
    const known = await inviteAs(existing.user.email);
    await signIn(jar, existing);
    const second = (await (await preview(known.token)).json()) as { invite: Record<string, unknown> };
    expect(second.invite).toMatchObject({ accountExists: true, viewer: { signedIn: true, isInvitee: true } });
  });

  it("answers 404 for malformed tokens and wrong secrets", async () => {
    const fresh = await inviteAs(uniqueEmail("bad"));
    const [id] = fresh.token.split(".");
    for (const token of ["nonsense", `${id}.${"A".repeat(43)}`, `${fresh.token}x`]) {
      const res = await preview(token);
      expect(res.status, token).toBe(404);
      expect(errorOf(await bodyOf(res)).code).toBe("invite_invalid");
    }
  });
});

describe("accept as a new person", () => {
  it("needs a name and a password that meets the policy", async () => {
    const fresh = await inviteAs(uniqueEmail("new"));
    await signOut();
    const missing = await accept({ token: fresh.token });
    expect(missing.status).toBe(422);
    expect(Object.keys(errorOf(await bodyOf(missing)).fieldErrors as object).sort()).toEqual(["name", "password"]);
    const weak = await accept({ token: fresh.token, name: "Asha Rao", password: "short" });
    expect(weak.status).toBe(422);
    expect((await db.authToken.findFirstOrThrow({ where: { email: fresh.email, type: "TEAM_INVITE" } })).usedAt).toBeNull();
  });

  it("sets the name and password, verifies the email, activates the membership and signs them in", async () => {
    const fresh = await inviteAs(uniqueEmail("new"), "BILLING");
    await signOut();
    const res = await accept({ token: fresh.token, name: "  Asha Rao ", password: NEW_PASSWORD });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirectTo: string; accountId: string; user: { email: string; name: string } };
    expect(body).toMatchObject({ redirectTo: "/account", accountId: owner.accountId, user: { email: fresh.email, name: "Asha Rao" } });

    const user = await db.user.findUniqueOrThrow({ where: { email: fresh.email } });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await verifyPassword(NEW_PASSWORD, user.passwordHash)).toBe(true);
    const member = await db.accountMember.findUniqueOrThrow({ where: { accountId_userId: { accountId: owner.accountId, userId: user.id } } });
    expect(member).toMatchObject({ status: "ACTIVE", role: "BILLING" });
    const session = await resolveSession(db, jar.get("axs_session"));
    expect(session?.user.id).toBe(user.id);
    expect(session?.session.activeAccountId).toBe(owner.accountId);
    const joined = await db.accountActivity.findFirstOrThrow({ where: { accountId: owner.accountId, action: "Joined the team" } });
    expect(joined).toMatchObject({ actorId: user.id, actorName: "Asha Rao", target: `${fresh.email} \u00B7 Billing admin`, kind: "team" });

    const again = await accept({ token: fresh.token, name: "Someone Else", password: NEW_PASSWORD });
    expect(again.status).toBe(410);
    expect(errorOf(await bodyOf(again)).code).toBe("invite_used");
  });

  it("joins with the role the owner chose after inviting", async () => {
    const fresh = await inviteAs(uniqueEmail("role"), "TECHNICAL");
    await call(jar, memberPATCH, `/api/account/team/${fresh.memberId}`, { method: "PATCH", body: { role: "VIEWER" }, params: { memberId: fresh.memberId } });
    await signOut();
    expect((await accept({ token: fresh.token, name: "Asha Rao", password: NEW_PASSWORD })).status).toBe(200);
    expect((await db.accountMember.findUniqueOrThrow({ where: { id: fresh.memberId } })).role).toBe("VIEWER");
  });

  it("needs the CSRF token", async () => {
    const fresh = await inviteAs(uniqueEmail("csrf"));
    await signOut();
    const res = await accept({ token: fresh.token, name: "Asha Rao", password: NEW_PASSWORD }, { csrf: false });
    expect(res.status).toBe(403);
    expect(errorOf(await bodyOf(res)).code).toBe("csrf_failed");
  });
});

describe("accept as an existing customer", () => {
  it("asks them to sign in, refuses another account, then joins with the session rotated", async () => {
    const asha = await makeMember({ name: "Asha Rao" });
    const known = await inviteAs(asha.user.email);
    await signOut();
    const signedOut = await accept({ token: known.token });
    expect(signedOut.status).toBe(401);
    expect(errorOf(await bodyOf(signedOut))).toMatchObject({ code: "sign_in_required", message: `Sign in as ${asha.user.email} to accept this invitation.` });

    const someoneElse = await makeMember();
    await signIn(jar, someoneElse);
    const wrong = await accept({ token: known.token });
    expect(wrong.status).toBe(403);
    expect(errorOf(await bodyOf(wrong)).code).toBe("wrong_account");

    await signIn(jar, asha);
    const before = jar.get("axs_session");
    const res = await accept({ token: known.token, name: "Ignored Name", password: "Ignored1pass" });
    expect(res.status).toBe(200);
    expect(jar.get("axs_session")).not.toBe(before);
    expect(await resolveSession(db, before)).toBeNull();
    const session = await resolveSession(db, jar.get("axs_session"));
    expect(session?.session.activeAccountId).toBe(owner.accountId);
    const user = await db.user.findUniqueOrThrow({ where: { id: asha.user.id } });
    expect(user.name).toBe("Asha Rao");
    expect(await verifyPassword(PASSWORD, user.passwordHash)).toBe(true);
    // Their own account stays theirs.
    expect(await db.accountMember.count({ where: { userId: asha.user.id, status: "ACTIVE" } })).toBe(2);
  });

  it("verifies an unverified customer's email (the link proves it)", async () => {
    const unverified = await makeMember({ name: "Asha Rao", verified: false });
    const known = await inviteAs(unverified.user.email);
    await signIn(jar, unverified);
    expect((await accept({ token: known.token })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: unverified.user.id } })).emailVerifiedAt).not.toBeNull();
  });
});

describe("unusable links", () => {
  it("expires after 7 days", async () => {
    const fresh = await inviteAs(uniqueEmail("old"));
    await db.authToken.updateMany({ where: { email: fresh.email, type: "TEAM_INVITE" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await signOut();
    for (const res of [await preview(fresh.token), await accept({ token: fresh.token, name: "Asha Rao", password: NEW_PASSWORD })]) {
      expect(res.status).toBe(410);
      expect(errorOf(await bodyOf(res))).toMatchObject({ code: "invite_expired", message: "This invitation has expired. Ask the account owner to send a new one." });
    }
  });

  it("stops working when the invitation is revoked or replaced by a resend", async () => {
    const revoked = await inviteAs(uniqueEmail("revoked"));
    await call(jar, memberDELETE, `/api/account/team/${revoked.memberId}`, { method: "DELETE", params: { memberId: revoked.memberId } });
    const replaced = await inviteAs(uniqueEmail("replaced"));
    await call(jar, resendPOST, `/api/account/team/${replaced.memberId}/resend`, { method: "POST", params: { memberId: replaced.memberId } });
    const fresh = await latestToken(replaced.email);
    expect(fresh).not.toBe(replaced.token);
    await signOut();
    expect((await preview(revoked.token)).status).toBe(404);
    const old = await accept({ token: replaced.token, name: "Asha Rao", password: NEW_PASSWORD });
    expect(old.status).toBe(410);
    expect(errorOf(await bodyOf(old)).code).toBe("invite_revoked");
    expect((await accept({ token: fresh, name: "Asha Rao", password: NEW_PASSWORD })).status).toBe(200);
  });
});
