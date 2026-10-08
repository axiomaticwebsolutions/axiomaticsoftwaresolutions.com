/**
 * Admin > My profile (decisions.md 2026-10-08): the /admin/profile server gate (signed out -> sign-in, customers ->
 * /account, staff without live access -> nothing, every active role -> its own profile and sessions), the top-bar
 * link, and staff using the shared /api/me routes: two-step on and off through POST /api/me/two-step with one admin
 * AuditLog row per change (actor = target = that staff member; customers keep their account activity instead),
 * password and sessions, and 403 for staff whose access is not live.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffRole, User } from "@/generated/prisma/client";
import { POST as passwordPOST } from "@/app/api/me/password/route";
import { GET as sessionsGET } from "@/app/api/me/sessions/route";
import { POST as twoStepPOST } from "@/app/api/me/two-step/route";
import { ADMIN_PROFILE_PATH, PROFILE_COPY } from "@/lib/admin/profile/model";
import { loadAdminProfilePage } from "@/lib/admin/profile/service";
import { csrfBinding, issueCsrfToken } from "@/lib/auth/csrf";
import { verifyPassword } from "@/lib/auth/password";
import { createSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { TWO_STEP_OFF_ACTION, TWO_STEP_ON_ACTION } from "@/lib/portal/profile";
import { makeUser, PASSWORD } from "./auth-fixtures";
import { bodyOf, call, errorOf } from "./portal-api-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
const request = vi.hoisted(() => ({ path: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string, options: { maxAge?: number } = {}) => {
      if (options.maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
  headers: async () => new Headers(request.path === null ? {} : { "x-axs-path": request.path }),
}));

beforeEach(() => {
  jar.clear();
  request.path = ADMIN_PROFILE_PATH;
});

/** The target of a next/navigation redirect() thrown by `promise`. */
async function redirectOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const digest = (error as { digest?: unknown }).digest;
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2] ?? "";
    throw error;
  }
  throw new Error("expected a redirect");
}

/** A staff member with the fixture password (two-step off, like every new staff member). */
async function makeStaff(role: StaffRole, staffStatus: "ACTIVE" | "INVITED" = "ACTIVE"): Promise<User> {
  const { user } = await makeUser({ kind: "STAFF", name: `Profile ${role.toLowerCase()}`, staffStatus });
  return db.user.update({ where: { id: user.id }, data: { staffRole: role } });
}

/** Signs `user` in on the jar: session cookie plus the CSRF token bound to it (what the browser holds). */
async function signInAs(user: User, activeAccountId: string | null = null): Promise<void> {
  jar.clear();
  const { token, session } = await createSession(db, { userId: user.id, kind: user.kind, activeAccountId });
  jar.set("axs_session", token);
  jar.set("axs_csrf", issueCsrfToken(csrfBinding(session.id), getEnv().CSRF_SECRET));
}

const twoStep = (body: unknown) => call(jar, twoStepPOST, "/api/me/two-step", { method: "POST", body });
const auditOf = (userId: string) =>
  db.auditLog.findMany({ where: { targetId: userId, action: { in: [TWO_STEP_ON_ACTION, TWO_STEP_OFF_ACTION] } }, orderBy: { createdAt: "asc" } });

describe("/admin/profile (server side)", () => {
  it("sends signed-out visitors to sign-in with the profile path", async () => {
    expect(await redirectOf(loadAdminProfilePage())).toBe("/sign-in?next=%2Fadmin%2Fprofile");
    jar.set("axs_session", "not-a-real-session-token");
    expect(await redirectOf(loadAdminProfilePage())).toBe("/sign-in?next=%2Fadmin%2Fprofile");
  });

  it("is refused for customers (sent to their portal)", async () => {
    const { user, accountId } = await makeUser();
    await signInAs(user, accountId);
    expect(await redirectOf(loadAdminProfilePage())).toBe("/account");
  });

  it("renders nothing for staff without live access (the layout shows its notice)", async () => {
    await signInAs(await makeStaff("OWNER", "INVITED"));
    expect(await loadAdminProfilePage()).toBeNull();
  });

  it("loads every active staff role's own details and sessions, whatever its permissions", async () => {
    for (const role of ["OWNER", "ADMIN", "SUPPORT", "FINANCE"] as const) {
      const staff = await makeStaff(role);
      await signInAs(staff);
      const data = await loadAdminProfilePage(new Date());
      expect(data?.profile, role).toEqual({ name: staff.name, email: staff.email, emailVerified: true, role, twoStepEnabled: false });
      expect(data?.sessions.filter((s) => s.current), role).toHaveLength(1);
      expect(JSON.stringify(data)).not.toMatch(/argon2|passwordHash|tokenHash/);
    }
  });

  it("is the page's only gate and is linked from the top bar's account menu next to Sign out", () => {
    const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");
    const page = read("app/admin/profile/page.tsx");
    expect(page).toContain("await loadAdminProfilePage()");
    expect(page).toContain("if (!data) return null;");
    const topbar = read("components/admin/admin-topbar.tsx");
    const link = topbar.indexOf("href={ADMIN_PROFILE_PATH}");
    expect(link).toBeGreaterThan(-1);
    expect(topbar.indexOf("Sign out", link)).toBeGreaterThan(link);
    expect(topbar).toContain("{PROFILE_COPY.menuLabel}");
    expect(PROFILE_COPY.menuLabel).toBe("My profile");
  });
});

describe("staff two-step through POST /api/me/two-step", () => {
  it.each(["OWNER", "FINANCE"] as const)("%s turns it on and off; each change writes one admin AuditLog row", async (role) => {
    const staff = await makeStaff(role);
    await signInAs(staff);
    expect(await bodyOf(await twoStep({ enabled: true }))).toEqual({ twoStepEnabled: true, changed: true });
    expect(await bodyOf(await twoStep({ enabled: true }))).toEqual({ twoStepEnabled: true, changed: false });
    expect((await db.user.findUniqueOrThrow({ where: { id: staff.id } })).twoStepEnabled).toBe(true);

    const wrong = await twoStep({ enabled: false, password: "Wrong1horse" });
    expect([wrong.status, errorOf(await bodyOf(wrong)).code]).toEqual([422, "incorrect_password"]);
    const before = await db.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(await bodyOf(await twoStep({ enabled: false, password: PASSWORD }))).toEqual({ twoStepEnabled: false, changed: true });
    const after = await db.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(after.twoStepEnabled).toBe(false);
    // Turning it off still invalidates trusted devices (the code flow is unchanged for people who turn it back on).
    expect(after.securityEpoch).toBe(before.securityEpoch + 1);

    const rows = await auditOf(staff.id);
    expect(rows.map((r) => [r.action, r.actorId, r.actorRole, r.target, r.targetType, r.targetId])).toEqual([
      [TWO_STEP_ON_ACTION, staff.id, role.toLowerCase(), staff.name, "staff", staff.id],
      [TWO_STEP_OFF_ACTION, staff.id, role.toLowerCase(), staff.name, "staff", staff.id],
    ]);
    expect(await db.accountActivity.count({ where: { actorId: staff.id } })).toBe(0);
  });

  it("customers keep their account activity and write no audit row", async () => {
    const { user, accountId } = await makeUser();
    await signInAs(user, accountId);
    expect(await bodyOf(await twoStep({ enabled: true }))).toEqual({ twoStepEnabled: true, changed: true });
    expect(await auditOf(user.id)).toHaveLength(0);
    expect(await db.accountActivity.count({ where: { accountId: accountId ?? "", action: TWO_STEP_ON_ACTION } })).toBe(1);
  });

  it("refuses staff without live access on the profile APIs, changing nothing", async () => {
    const invited = await makeStaff("FINANCE", "INVITED");
    await signInAs(invited);
    expect((await twoStep({ enabled: true })).status).toBe(403);
    expect((await call(jar, sessionsGET, "/api/me/sessions")).status).toBe(403);
    const password = await call(jar, passwordPOST, "/api/me/password", { method: "POST", body: { current: PASSWORD, next: "Another9horse" } });
    expect(password.status).toBe(403);
    const row = await db.user.findUniqueOrThrow({ where: { id: invited.id } });
    expect(row.twoStepEnabled).toBe(false);
    expect(await verifyPassword(PASSWORD, row.passwordHash)).toBe(true);
    expect(await auditOf(invited.id)).toHaveLength(0);
  });

  it("lets active staff list their sessions and change the password through the same routes", async () => {
    const staff = await makeStaff("SUPPORT");
    await createSession(db, { userId: staff.id, kind: "STAFF" });
    await signInAs(staff);
    const listed = await call(jar, sessionsGET, "/api/me/sessions");
    expect(listed.status).toBe(200);
    const sessions = (await bodyOf(listed)).sessions as Array<{ current: boolean }>;
    expect(sessions.filter((s) => s.current)).toHaveLength(1);
    expect(sessions).toHaveLength(2);
    const changed = await call(jar, passwordPOST, "/api/me/password", { method: "POST", body: { current: PASSWORD, next: "Another9horse" } });
    expect([changed.status, await bodyOf(changed)]).toEqual([200, { revokedSessions: 1 }]);
    expect(await verifyPassword("Another9horse", (await db.user.findUniqueOrThrow({ where: { id: staff.id } })).passwordHash)).toBe(true);
  });
});
