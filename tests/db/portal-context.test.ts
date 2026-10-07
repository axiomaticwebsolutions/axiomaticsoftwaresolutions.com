/**
 * Portal shell server side (lib/portal/context.ts) and the verified-email guards (lib/auth/guards.ts):
 * redirects for signed-out, staff and unverified visitors, the no-account state, the active account and role,
 * accounts list, locations with active device counts and the badge counts.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { requireAccountRole, requireVerifiedCustomer } from "@/lib/auth/guards";
import { createSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { deriveLicenseStatus } from "@/lib/licensing/status";
import {
  getPortalContext,
  getPortalState,
  licensesNeedingAttentionWhere,
  loadPortalData,
  portalPathFrom,
  portalRedirect,
} from "@/lib/portal/context";
import { uniqueEmail } from "./auth-fixtures";
import {
  DAY,
  makeCatalog,
  makeDevice,
  makeLicense,
  makeLocation,
  makeMember,
  signIn,
  type Catalog,
  type Member,
} from "./license-actions-fixtures";

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

const tag = () => randomBytes(4).toString("hex");
const now = Date.now();
const at = (days: number) => new Date(now + days * DAY);

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

let catalog: Catalog;
beforeAll(async () => {
  catalog = await makeCatalog();
});
beforeEach(() => {
  jar.clear();
  request.path = null;
});

describe("verified-email guards", () => {
  it("refuse unverified customers with 403 email_unverified; the default requireAccountRole stays unchanged", async () => {
    const unverified = await makeMember({ verified: false });
    await signIn(jar, unverified);
    await expect(requireVerifiedCustomer()).rejects.toMatchObject({ status: 403, code: "email_unverified" });
    await expect(requireAccountRole("licenses.view", { verified: true })).rejects.toMatchObject({ status: 403, code: "email_unverified" });
    await expect(requireAccountRole("licenses.view")).resolves.toMatchObject({ account: { id: unverified.accountId } });

    const verified = await makeMember();
    await signIn(jar, verified);
    await expect(requireVerifiedCustomer()).resolves.toMatchObject({ user: { id: verified.user.id } });
    await expect(requireAccountRole("team.manage", { verified: true })).resolves.toMatchObject({ membership: { role: "OWNER" } });

    jar.clear();
    await expect(requireVerifiedCustomer()).rejects.toMatchObject({ status: 401 });
  });

  it("still checks the team role after the email", async () => {
    const owner = await makeMember();
    const viewer = await makeMember({ accountId: owner.accountId, role: "VIEWER" });
    await signIn(jar, viewer);
    await expect(requireAccountRole("keys.reveal", { verified: true })).rejects.toMatchObject({ status: 403, code: "forbidden" });
  });
});

describe("redirect rules", () => {
  it("keep only portal paths from the middleware header", () => {
    expect(portalPathFrom("/account/licenses?status=expired")).toBe("/account/licenses?status=expired");
    expect(portalPathFrom("/account")).toBe("/account");
    for (const bad of [null, "", "//evil.example/account", "https://evil.example/account", "/admin", "/accounts", "/api/account/x"]) {
      expect(portalPathFrom(bad)).toBe("/account");
    }
  });

  it("send signed-out visitors to sign-in, staff to /admin and unverified customers to verify", async () => {
    const member = await makeMember({ verified: false });
    const user = member.user;
    const session = { id: "s" } as never;
    expect(portalRedirect(null, "/account/devices")).toBe("/sign-in?next=%2Faccount%2Fdevices");
    expect(portalRedirect({ session, user: { ...user, kind: "STAFF" } }, "/account")).toBe("/admin");
    expect(portalRedirect({ session, user }, "/account/tickets/new")).toBe("/verify?next=%2Faccount%2Ftickets%2Fnew");
    expect(portalRedirect({ session, user: { ...user, emailVerifiedAt: new Date() } }, "/account")).toBeNull();
  });
});

describe("getPortalState", () => {
  it("redirects a stale session cookie to sign-in with the requested path", async () => {
    jar.set("axs_session", "not-a-real-session-token");
    request.path = "/account/licenses?status=expired";
    expect(await redirectOf(getPortalState())).toBe("/sign-in?next=%2Faccount%2Flicenses%3Fstatus%3Dexpired");
  });

  it("redirects unverified customers to verify and staff to the admin console", async () => {
    const unverified = await makeMember({ verified: false });
    await signIn(jar, unverified);
    request.path = "/account/devices";
    expect(await redirectOf(getPortalState())).toBe("/verify?next=%2Faccount%2Fdevices");

    const staff = await db.user.create({
      data: { email: uniqueEmail("staff"), name: "Staff Person", kind: "STAFF", staffRole: "SUPPORT", staffStatus: "ACTIVE", emailVerifiedAt: new Date() },
    });
    jar.clear();
    const { token } = await createSession(db, { userId: staff.id, kind: "STAFF" });
    jar.set("axs_session", token);
    expect(await redirectOf(getPortalState())).toBe("/admin");
  });

  it("loads the active account, role and permissions for a verified member", async () => {
    const owner = await makeMember();
    const tech = await makeMember({ accountId: owner.accountId, role: "TECHNICAL", name: "Kavya Desai" });
    await signIn(jar, tech);
    const state = await getPortalState();
    expect(state.kind).toBe("ready");
    const ctx = await getPortalContext();
    expect(ctx.role).toBe("TECHNICAL");
    expect(ctx.account.id).toBe(owner.accountId);
    expect(ctx.user).toEqual({ id: tech.user.id, name: "Kavya Desai", email: tech.user.email });
    expect(ctx.can("keys.reveal")).toBe(true);
    expect(ctx.can("team.manage")).toBe(false);
    expect(ctx.can("purchases")).toBe(false);
    expect(ctx.auth.membership.role).toBe("TECHNICAL");
  });

  it("reports a verified customer without an active membership as no_account", async () => {
    const owner = await makeMember();
    const invited = await makeMember({ accountId: owner.accountId, role: "VIEWER" });
    await db.accountMember.updateMany({ where: { userId: invited.user.id }, data: { status: "INVITED" } });
    await signIn(jar, invited);
    expect(await getPortalState()).toEqual({
      kind: "no_account",
      user: { id: invited.user.id, name: invited.user.name, email: invited.user.email },
    });
    await expect(getPortalContext()).rejects.toMatchObject({ status: 403, code: "no_account" });
  });
});

describe("loadPortalData", () => {
  let owner: Member;
  let otherAccountId: string;

  beforeEach(async () => {
    owner = await makeMember();
    otherAccountId = (await makeMember({ name: "Other Owner" })).accountId;
  });

  it("lists the user's active businesses in membership order and switches with session.activeAccountId", async () => {
    const second = await db.businessAccount.create({ data: { legalName: `Joshi Pharma ${tag()}` } });
    const third = await db.businessAccount.create({ data: { legalName: `Invited Co ${tag()}` } });
    // Joined after the owner membership made in beforeEach (relative to the clock now, not the file load time, so a
    // slow run cannot put it first).
    await db.accountMember.create({ data: { accountId: second.id, userId: owner.user.id, role: "VIEWER", createdAt: new Date(Date.now() + 60_000) } });
    await db.accountMember.create({ data: { accountId: third.id, userId: owner.user.id, role: "BILLING", status: "INVITED" } });
    await signIn(jar, owner);
    const first = await loadPortalData(db, await requireAccountRole(undefined, { verified: true }));
    expect(first.accounts.map((a) => a.id)).toEqual([owner.accountId, second.id]);
    expect(first.role).toBe("OWNER");

    await db.session.updateMany({ where: { userId: owner.user.id }, data: { activeAccountId: second.id } });
    const switched = await loadPortalData(db, await requireAccountRole(undefined, { verified: true }));
    expect(switched.account).toEqual({ id: second.id, legalName: second.legalName });
    expect(switched.role).toBe("VIEWER");
    expect(switched.accounts.map((a) => a.id)).toEqual([owner.accountId, second.id]);
  });

  it("counts active devices per location of the account only", async () => {
    const counter = await makeLocation(owner.accountId, "FC Road (main store)");
    const branch = await makeLocation(owner.accountId, "Kothrud branch");
    const foreign = await makeLocation(otherAccountId, "Elsewhere");
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, deviceLimit: 5 });
    const { license: foreignLicense } = await makeLicense(catalog, { accountId: otherAccountId });
    await makeDevice(license.id, { locationId: counter.id });
    await makeDevice(license.id, { locationId: counter.id });
    await makeDevice(license.id, { locationId: counter.id, deactivatedAt: at(-1) });
    await makeDevice(license.id, { locationId: null });
    await makeDevice(foreignLicense.id, { locationId: foreign.id });
    await signIn(jar, owner);
    const data = await loadPortalData(db, await requireAccountRole());
    expect(data.locations).toEqual([
      { id: counter.id, name: "FC Road (main store)", activeDevices: 2 },
      { id: branch.id, name: "Kothrud branch", activeDevices: 0 },
    ]);
  });

  it("counts open tickets, the user's unread notifications and licenses that need attention", async () => {
    const coworker = await makeMember({ accountId: owner.accountId, role: "BILLING" });
    const ticket = (accountId: string, status: "OPEN" | "AWAITING_CUSTOMER" | "RESOLVED" | "CLOSED") =>
      db.supportTicket.create({ data: { id: `T-PC${tag().toUpperCase()}`, accountId, subject: "Printer offline", status } });
    await Promise.all([
      ticket(owner.accountId, "OPEN"),
      ticket(owner.accountId, "AWAITING_CUSTOMER"),
      ticket(owner.accountId, "RESOLVED"),
      ticket(owner.accountId, "CLOSED"),
      ticket(otherAccountId, "OPEN"),
    ]);
    const note = (userId: string, readAt: Date | null) =>
      db.notification.create({ data: { userId, kind: "renewal", title: "Renew soon", body: "Body", readAt } });
    await Promise.all([note(owner.user.id, null), note(owner.user.id, null), note(owner.user.id, at(-1)), note(coworker.user.id, null)]);

    const mk = (opts: Parameters<typeof makeLicense>[1]) => makeLicense(catalog, opts);
    await Promise.all([
      mk({ accountId: owner.accountId, expiresAt: at(200) }),
      mk({ accountId: owner.accountId, expiresAt: at(20) }),
      mk({ accountId: owner.accountId, expiresAt: at(59.5) }),
      mk({ accountId: owner.accountId, expiresAt: at(61) }),
      mk({ accountId: owner.accountId, expiresAt: at(-5) }),
      mk({ accountId: owner.accountId, plan: catalog.trial, status: "TRIAL", expiresAt: at(10), deviceLimit: 1 }),
      mk({ accountId: owner.accountId, plan: catalog.trial, status: "TRIAL", expiresAt: at(-2), deviceLimit: 1 }),
      mk({ accountId: owner.accountId, status: "REVOKED", expiresAt: at(-5) }),
      mk({ accountId: owner.accountId, status: "SUSPENDED", expiresAt: at(20) }),
      mk({ accountId: owner.accountId, plan: catalog.oneTime, expiresAt: null, updatesUntil: at(-30), deviceLimit: 1 }),
      mk({ accountId: otherAccountId, expiresAt: at(5) }),
    ]);

    await signIn(jar, owner);
    const when = new Date();
    const data = await loadPortalData(db, await requireAccountRole(), when);
    const licenses = await db.license.findMany({ where: { accountId: owner.accountId } });
    const derived = licenses.filter((l) => ["expiring", "expired"].includes(deriveLicenseStatus(l, when))).length;
    expect(derived).toBe(4);
    expect(data.counts).toEqual({ tickets: 2, notifications: 2, licensesNeedingAttention: derived });
    expect(await db.license.count({ where: licensesNeedingAttentionWhere(owner.accountId, when) })).toBe(derived);
  });
});
