/**
 * The signed-in user's own settings: notifications (list, unread count, mark read; other users' ids ignored), email
 * preferences (DPDP consent time), profile (name, mobile), two-step on/off (password to turn off, rate limited,
 * activity with the actor id) and the active business account (ACTIVE memberships only).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as notificationsGET, PATCH as notificationsPATCH } from "@/app/api/account/notifications/route";
import { POST as readPOST } from "@/app/api/account/notifications/read/route";
import { POST as activeAccountPOST } from "@/app/api/me/active-account/route";
import { GET as prefsGET, PATCH as prefsPATCH } from "@/app/api/me/preferences/route";
import { PATCH as mePATCH } from "@/app/api/me/route";
import { POST as twoStepPOST } from "@/app/api/me/two-step/route";
import { db } from "@/lib/db";
import { bodyOf, call, DAY, errorOf, makeMember, makeNotification, PASSWORD, signIn, type Member } from "./portal-api-fixtures";

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

let me: Member;
let other: Member;

beforeAll(async () => {
  me = await makeMember({ name: "Priya Sharma" });
  other = await makeMember({ name: "Other Owner" });
});

describe("notifications", () => {
  it("lists the user's own notifications newest first with the unread count and preferences", async () => {
    const base = Date.now();
    const mine = [];
    for (let i = 0; i < 33; i++) mine.push(await makeNotification(me.user.id, { at: new Date(base - i * 60_000), read: i % 2 === 1 }));
    await makeNotification(me.user.id, { at: new Date(base - DAY), href: "https://evil.example/" });
    const theirs = await makeNotification(other.user.id);
    await signIn(jar, me);
    const page1 = await bodyOf(await call(jar, notificationsGET, "/api/account/notifications"));
    const rows = page1.notifications as Array<{ id: string; read: boolean; href: string | null }>;
    expect(rows).toHaveLength(30);
    expect(rows[0]?.id).toBe(mine[0]?.id);
    expect(page1.unread).toBe(18);
    expect(page1.prefs).toEqual({ renewals: true, updates: true, tickets: true, offers: false, offersConsentAt: null });
    const page2 = await bodyOf(await call(jar, notificationsGET, `/api/account/notifications?cursor=${String(page1.nextCursor)}`));
    const rows2 = page2.notifications as Array<{ id: string; href: string | null }>;
    expect(rows2).toHaveLength(4);
    expect(page2.nextCursor).toBeNull();
    expect(rows2[3]?.href).toBeNull();
    expect([...rows, ...rows2].map((r) => r.id)).not.toContain(theirs.id);
    const unread = await bodyOf(await call(jar, notificationsGET, "/api/account/notifications?filter=unread"));
    expect((unread.notifications as Array<{ read: boolean }>).every((n) => !n.read)).toBe(true);

    // Marking another user's notification does nothing; "Mark all read" clears the rest.
    const some = await bodyOf(await call(jar, readPOST, "/api/account/notifications/read", { method: "POST", body: { ids: [mine[0]?.id, theirs.id] } }));
    expect(some).toEqual({ updated: 1, unread: 17 });
    expect((await db.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt).toBeNull();
    const all = await bodyOf(await call(jar, readPOST, "/api/account/notifications/read", { method: "POST" }));
    expect(all).toEqual({ updated: 17, unread: 0 });
  });
});

describe("email preferences", () => {
  it("records consent when offers turn on, through either route", async () => {
    await signIn(jar, me);
    const on = await bodyOf(await call(jar, prefsPATCH, "/api/me/preferences", { method: "PATCH", body: { offers: true, tickets: false } }));
    const prefs = on.prefs as { offers: boolean; tickets: boolean; offersConsentAt: string };
    expect(prefs).toMatchObject({ offers: true, tickets: false });
    expect(Date.parse(prefs.offersConsentAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(await bodyOf(await call(jar, prefsGET, "/api/me/preferences"))).toEqual(on);
    const off = await bodyOf(await call(jar, notificationsPATCH, "/api/account/notifications", { method: "PATCH", body: { offers: false } }));
    expect(off.prefs).toMatchObject({ offers: false, offersConsentAt: null, tickets: false });
    const stored = (await db.user.findUniqueOrThrow({ where: { id: me.user.id } })).notificationPrefs as Record<string, unknown>;
    expect(typeof stored.offersWithdrawnAt).toBe("string");
    const bad = await call(jar, prefsPATCH, "/api/me/preferences", { method: "PATCH", body: { offers: true, sms: true } });
    expect(bad.status).toBe(422);
  });
});

describe("PATCH /api/me", () => {
  it("saves the name and mobile, without an activity entry", async () => {
    await signIn(jar, me);
    const res = await call(jar, mePATCH, "/api/me", { method: "PATCH", body: { name: " Priya  S. Sharma ", phone: "+91 98200 00001" } });
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).user).toMatchObject({ name: "Priya S. Sharma", phone: "9820000001", email: me.user.email });
    const bad = await call(jar, mePATCH, "/api/me", { method: "PATCH", body: { phone: "12345" } });
    expect(bad.status).toBe(422);
    expect(errorOf(await bodyOf(bad)).fieldErrors).toHaveProperty("phone");
    const cleared = await bodyOf(await call(jar, mePATCH, "/api/me", { method: "PATCH", body: { phone: "" } }));
    expect((cleared.user as { phone: string | null }).phone).toBeNull();
    expect(await db.accountActivity.count({ where: { accountId: me.accountId } })).toBe(0);
    const noCsrf = await call(jar, mePATCH, "/api/me", { method: "PATCH", body: { name: "X" }, csrf: false });
    expect(noCsrf.status).toBe(403);
  });
});

describe("POST /api/me/two-step", () => {
  const twoStep = (body: unknown) => call(jar, twoStepPOST, "/api/me/two-step", { method: "POST", body });
  const securityLog = (accountId: string) =>
    db.accountActivity.findMany({ where: { accountId, kind: "security" }, orderBy: { createdAt: "asc" } });

  it("turns on without a password and off only with the right one, logging both with the actor", async () => {
    const member = await makeMember({ name: "Kavya Desai" });
    await signIn(jar, member);
    expect(await bodyOf(await twoStep({ enabled: true }))).toEqual({ twoStepEnabled: true, changed: true });
    expect(await bodyOf(await twoStep({ enabled: true }))).toEqual({ twoStepEnabled: true, changed: false });
    const missing = await twoStep({ enabled: false });
    expect(missing.status).toBe(422);
    const wrong = await twoStep({ enabled: false, password: "Wrong1horse" });
    expect(wrong.status).toBe(422);
    expect(errorOf(await bodyOf(wrong))).toMatchObject({ code: "incorrect_password", message: "Incorrect password." });
    expect((await db.user.findUniqueOrThrow({ where: { id: member.user.id } })).twoStepEnabled).toBe(true);
    expect(await bodyOf(await twoStep({ enabled: false, password: PASSWORD }))).toEqual({ twoStepEnabled: false, changed: true });
    const log = await securityLog(member.accountId);
    expect(log.map((a) => [a.action, a.target, a.actorId])).toEqual([
      ["Turned on two-step verification", member.user.email, member.user.id],
      ["Turned off two-step verification", member.user.email, member.user.id],
    ]);
  });

  it("limits password checks to 5 per 15 minutes", async () => {
    const member = await makeMember();
    await db.user.update({ where: { id: member.user.id }, data: { twoStepEnabled: true } });
    await signIn(jar, member);
    for (let i = 0; i < 5; i++) expect((await twoStep({ enabled: false, password: `Wrong${i}horse` })).status).toBe(422);
    const limited = await twoStep({ enabled: false, password: PASSWORD });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect((await db.user.findUniqueOrThrow({ where: { id: member.user.id } })).twoStepEnabled).toBe(true);
  });

  it("needs a verified email to turn it on", async () => {
    const member = await makeMember({ verified: false });
    await signIn(jar, member);
    const res = await twoStep({ enabled: true });
    expect(res.status).toBe(403);
    expect(errorOf(await bodyOf(res)).code).toBe("email_unverified");
  });
});

describe("POST /api/me/active-account", () => {
  it("switches between the user's ACTIVE memberships only", async () => {
    const first = await makeMember({ name: "Multi Owner" });
    const second = await db.businessAccount.create({ data: { legalName: "Second Business" } });
    await db.accountMember.create({ data: { accountId: second.id, userId: first.user.id, role: "VIEWER" } });
    const pending = await db.businessAccount.create({ data: { legalName: "Pending Business" } });
    await db.accountMember.create({ data: { accountId: pending.id, userId: first.user.id, role: "TECHNICAL", status: "INVITED" } });
    await signIn(jar, first);
    const switched = await call(jar, activeAccountPOST, "/api/me/active-account", { method: "POST", body: { accountId: second.id } });
    expect(switched.status).toBe(200);
    expect(await bodyOf(switched)).toEqual({ account: { id: second.id, legalName: "Second Business" }, role: "VIEWER" });
    const session = await db.session.findFirstOrThrow({ where: { userId: first.user.id, revokedAt: null }, orderBy: { createdAt: "desc" } });
    expect(session.activeAccountId).toBe(second.id);
    for (const accountId of [pending.id, other.accountId, "nope_123"]) {
      const res = await call(jar, activeAccountPOST, "/api/me/active-account", { method: "POST", body: { accountId } });
      expect(res.status).toBe(404);
    }
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).activeAccountId).toBe(second.id);
  });
});
