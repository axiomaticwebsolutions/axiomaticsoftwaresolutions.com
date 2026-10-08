/**
 * Staff invitation links (/api/staff-invites/*): preview, acceptance (name + password policy, email verified, staff
 * session started, two-step off for every role even on rows invited under the old rule, audit row), single use,
 * expiry, replacement by a resend, revocation, CSRF, "sign out first" for a signed-in browser, and customer emails
 * refused at invite time. The staff_invite email is sent directly (captured here from the email transport) and never
 * stored in the outbox.
 */
import { randomBytes, randomInt } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as invitePOST } from "@/app/api/admin/staff/route";
import { DELETE as revokeDELETE } from "@/app/api/admin/staff/[id]/invite/route";
import { POST as resendPOST } from "@/app/api/admin/staff/[id]/resend-invite/route";
import { GET as settingsGET } from "@/app/api/admin/settings/route";
import { POST as acceptPOST } from "@/app/api/staff-invites/accept/route";
import { GET as previewGET } from "@/app/api/staff-invites/[token]/route";
import { STAFF_RATE_LIMITS } from "@/lib/admin/staff/limits";
import { ANON_CSRF_BINDING, issueCsrfToken } from "@/lib/auth/csrf";
import { signIn } from "@/lib/auth/flows/sign-in";
import { verifyPassword } from "@/lib/auth/password";
import { clear } from "@/lib/auth/rate-limit";
import { resolveSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { setEmailTransport, type OutgoingEmail } from "@/lib/email";
import { getEnv } from "@/lib/env";
import { callRoute, errorCodeOf, makeCustomer, makeStaff, startSession, type TestSession } from "../support/admin-fixtures";
import { call } from "./license-actions-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

const PASSWORD = "Console2joined";
const tag = () => randomBytes(4).toString("hex");
const email = (label: string) => `m7-accept-${label}.${tag()}@axiomatic.test`;
let owner: TestSession;
const sent: OutgoingEmail[] = [];

beforeAll(() => {
  setEmailTransport({ name: "test", send: async (mail) => (sent.push(mail), { messageId: `m${sent.length}` }) });
});
afterAll(() => setEmailTransport(null));

beforeEach(async () => {
  await clear(db, STAFF_RATE_LIMITS.acceptIp(null).key);
  await clear(db, STAFF_RATE_LIMITS.previewIp(null).key);
  owner = await startSession(await makeStaff("OWNER"));
});

async function invite(address: string, role = "SUPPORT"): Promise<{ id: string; token: string }> {
  const res = await callRoute(jar, invitePOST, { method: "POST", path: "/api/admin/staff", body: { email: address, role }, session: owner });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { staff: { id: string }; emailSent: boolean };
  expect(body.emailSent).toBe(true);
  return { id: body.staff.id, token: await latestToken(address) };
}

async function latestToken(address: string): Promise<string> {
  const mail = sent.filter((m) => m.to === address && m.templateId === "staff_invite").at(-1);
  if (!mail) throw new Error("no invitation email sent");
  // Sent directly: the link is never stored (a database read must not yield a working invitation).
  expect(await db.outboxEmail.count({ where: { to: address } })).toBe(0);
  const match = /\/staff-invite\?token=([A-Za-z0-9._%-]+)/.exec(mail.text);
  if (!match?.[1]) throw new Error("no invite link in the email");
  return decodeURIComponent(match[1]);
}

/** A visitor without a session (the anonymous CSRF token GET /api/csrf issues). */
function anonymous(): void {
  jar.clear();
  jar.set("axs_csrf", issueCsrfToken(ANON_CSRF_BINDING, getEnv().CSRF_SECRET));
}

const preview = (token: string) => call(jar, previewGET, `/api/staff-invites/${encodeURIComponent(token)}`, { params: { token } });
const accept = (body: Record<string, unknown>, opts: { csrf?: boolean } = {}) =>
  call(jar, acceptPOST, "/api/staff-invites/accept", { method: "POST", body, ...opts });
type Json = Record<string, unknown>;

describe("preview", () => {
  it("shows the role, the inviter and the expiry without changing anything", async () => {
    const address = email("preview");
    const { token } = await invite(address, "FINANCE");
    anonymous();
    const res = await preview(token);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const { invite: body } = (await res.json()) as { invite: Json };
    expect(body).toMatchObject({ email: address, role: "FINANCE", roleLabel: "Finance", inviterName: "Anita Desai", viewer: { signedIn: false, email: null } });
    // Two-step sign-in is optional for every role (decisions.md 2026-10-08): the preview no longer announces a code.
    expect(body).not.toHaveProperty("twoStep");
    expect((await db.authToken.findFirstOrThrow({ where: { email: address, type: "STAFF_INVITE" } })).usedAt).toBeNull();
  });

  it("answers 404 invite_invalid for malformed tokens and wrong secrets", async () => {
    const { token } = await invite(email("bad"));
    anonymous();
    const [id] = token.split(".");
    for (const bad of ["nonsense", `${id}.${"A".repeat(43)}`, `${token}x`]) {
      const res = await preview(bad);
      expect(res.status, bad).toBe(404);
      expect(await errorCodeOf(res)).toBe("invite_invalid");
    }
  });
});

describe("accept", () => {
  it("activates the person with a verified email, signs them in to the console and audits it (single use)", async () => {
    const address = email("new");
    const { id, token } = await invite(address, "FINANCE");
    anonymous();
    const res = await accept({ token, name: "  Meera Iyer ", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectTo: "/admin", user: { id, name: "Meera Iyer", email: address } });

    const user = await db.user.findUniqueOrThrow({ where: { id } });
    expect(user).toMatchObject({ kind: "STAFF", staffRole: "FINANCE", staffStatus: "ACTIVE", name: "Meera Iyer", twoStepEnabled: false });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(await verifyPassword(PASSWORD, user.passwordHash)).toBe(true);
    const sessionToken = jar.get("axs_session");
    expect((await resolveSession(db, sessionToken))?.user.id).toBe(id);
    const audit = await db.auditLog.findFirstOrThrow({ where: { targetId: id, action: "Accepted staff invitation" } });
    expect([audit.actorId, audit.actorRole, audit.detail]).toEqual([id, "finance", "Finance"]);

    // The new session is an active staff session: Finance gets 403 (not 401) on an Owner-only route.
    const owned = await call(jar, settingsGET, "/api/admin/settings");
    expect([owned.status, await errorCodeOf(owned)]).toEqual([403, "forbidden"]);

    anonymous();
    const again = await accept({ token, name: "Someone Else", password: PASSWORD });
    expect([again.status, await errorCodeOf(again)]).toEqual([410, "invite_used"]);
  });

  it("starts two-step off for an invitee whose row still has it on from the old Owner/Finance rule", async () => {
    const address = email("legacy");
    const { id, token } = await invite(address, "FINANCE");
    // Invited before decisions.md 2026-10-08: Owner and Finance invitees were created with two-step on.
    await db.user.update({ where: { id }, data: { twoStepEnabled: true } });
    anonymous();
    const res = await accept({ token, name: "Legacy Finance", password: PASSWORD });
    expect(res.status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).twoStepEnabled).toBe(false);

    // A password sign-in completes without an emailed code (no lockout while email sending is not set up).
    const ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
    const result = await signIn({ email: address, password: PASSWORD }, { ip, userAgent: "Vitest", now: new Date() });
    expect(result.requires2fa).toBe(false);
    expect(await db.authToken.count({ where: { userId: id, type: "LOGIN_OTP" } })).toBe(0);
  });

  it("checks the name and password policy and needs the CSRF token", async () => {
    const { id, token } = await invite(email("policy"));
    anonymous();
    const weak = await accept({ token, name: "Asha Rao", password: "short" });
    expect(weak.status).toBe(422);
    const weakBody = (await weak.json()) as { error: { fieldErrors: Record<string, string[]> } };
    expect(weakBody.error.fieldErrors.password).toEqual(["Use at least 8 characters with letters and a number."]);
    const linkName = await accept({ token, name: "www.example.com", password: PASSWORD });
    expect(linkName.status).toBe(422);
    const noCsrf = await accept({ token, name: "Asha Rao", password: PASSWORD }, { csrf: false });
    expect([noCsrf.status, await errorCodeOf(noCsrf)]).toEqual([403, "csrf_failed"]);
    expect((await db.user.findUniqueOrThrow({ where: { id } })).staffStatus).toBe("INVITED");
  });

  it("asks a signed-in browser to sign out first", async () => {
    const { token } = await invite(email("signed-in"));
    const { user } = await makeCustomer();
    const customer = await startSession(user);
    jar.clear();
    jar.set("axs_session", customer.token);
    jar.set("axs_csrf", customer.csrf);
    const prev = (await (await preview(token)).json()) as { invite: { viewer: Json } };
    expect(prev.invite.viewer).toEqual({ signedIn: true, email: user.email });
    const res = await accept({ token, name: "Asha Rao", password: PASSWORD });
    expect([res.status, await errorCodeOf(res)]).toEqual([403, "signed_in"]);
  });

  it("refuses expired links, links replaced by a resend and revoked invitations", async () => {
    const expired = await invite(email("expired"));
    await db.authToken.updateMany({ where: { userId: expired.id, type: "STAFF_INVITE" }, data: { expiresAt: new Date(Date.now() - 1000) } });
    anonymous();
    expect(await errorCodeOf(await preview(expired.token))).toBe("invite_expired");
    expect(await errorCodeOf(await accept({ token: expired.token, name: "Asha Rao", password: PASSWORD }))).toBe("invite_expired");

    const replaced = await invite(email("replaced"));
    const resend = await callRoute(jar, resendPOST, { method: "POST", path: `/api/admin/staff/${replaced.id}/resend-invite`, params: { id: replaced.id }, body: {}, session: owner });
    expect(resend.status).toBe(200);
    const fresh = await latestToken((await db.user.findUniqueOrThrow({ where: { id: replaced.id } })).email);
    expect(fresh).not.toBe(replaced.token);
    anonymous();
    expect(await errorCodeOf(await accept({ token: replaced.token, name: "Asha Rao", password: PASSWORD }))).toBe("invite_revoked");
    expect((await accept({ token: fresh, name: "Asha Rao", password: PASSWORD })).status).toBe(200);

    const revoked = await invite(email("revoked"));
    const noReason = await callRoute(jar, revokeDELETE, { method: "DELETE", path: `/api/admin/staff/${revoked.id}/invite`, params: { id: revoked.id }, body: {}, session: owner });
    expect(await errorCodeOf(noReason)).toBe("reason_required");
    const del = await callRoute(jar, revokeDELETE, { method: "DELETE", path: `/api/admin/staff/${revoked.id}/invite`, params: { id: revoked.id }, body: { reason: "Sent to the wrong address" }, session: owner });
    expect(del.status).toBe(200);
    anonymous();
    expect(await errorCodeOf(await preview(revoked.token))).toBe("invite_invalid");
  });
});

describe("invite route", () => {
  it("refuses an email that belongs to a customer, with a clear message", async () => {
    const { user } = await makeCustomer();
    const res = await callRoute(jar, invitePOST, { method: "POST", path: "/api/admin/staff", body: { email: user.email.toUpperCase(), role: "SUPPORT" }, session: owner });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("customer_email");
    expect(body.error.message).toBe(
      "This email belongs to a customer account. Staff and customer accounts are kept apart, so invite a different email address.",
    );
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).kind).toBe("CUSTOMER");
  });
});
