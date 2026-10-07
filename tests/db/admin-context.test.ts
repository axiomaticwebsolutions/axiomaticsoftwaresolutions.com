/**
 * Admin console shell server side (lib/admin/context.ts): redirects for signed-out visitors and customers, the
 * inactive-staff state, the staff member, module locks per role, permission checks, sidebar badge counts and the
 * payment "Test mode" flag.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffRole, User } from "@/generated/prisma/client";
import {
  AdminAccessInactiveError,
  adminRedirect,
  getAdminContext,
  getAdminState,
  isPaymentTestMode,
  loadAdminBadges,
  toAdminContextData,
} from "@/lib/admin/context";
import { createSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { lockedModulesFor } from "@/lib/rbac";
import { makeUser } from "./auth-fixtures";

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

const tag = () => randomBytes(4).toString("hex").toUpperCase();
const created = { orders: [] as string[], tickets: [] as string[] };

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

async function makeStaff(role: StaffRole, staffStatus: "ACTIVE" | "INVITED" | "DEACTIVATED" = "ACTIVE"): Promise<User> {
  const { user } = await makeUser({ kind: "STAFF", name: `Staff ${role.toLowerCase()}`, staffStatus });
  return db.user.update({ where: { id: user.id }, data: { staffRole: role } });
}

async function signInAs(user: User): Promise<void> {
  jar.clear();
  const { token } = await createSession(db, { userId: user.id, kind: user.kind });
  jar.set("axs_session", token);
}

async function makeOrder(status: "PENDING" | "REVIEW" | "PAID" | "CONFIRMING"): Promise<void> {
  const id = `AX-A1${tag()}`;
  await db.order.create({
    data: {
      id,
      email: `admin-ctx.${tag().toLowerCase()}@example.test`,
      billing: { name: "Admin Context Test", state: "Maharashtra" },
      status,
      subtotalPaise: 100_000,
      taxablePaise: 100_000,
      cgstPaise: 9_000,
      sgstPaise: 9_000,
      totalPaise: 118_000,
      placeOfSupply: "Maharashtra",
    },
  });
  created.orders.push(id);
}

async function makeTicket(accountId: string, status: "OPEN" | "AWAITING_CUSTOMER", assigneeId: string | null): Promise<void> {
  const id = `T-A1${tag()}`;
  await db.supportTicket.create({ data: { id, accountId, subject: "Admin context badge test", status, assigneeId } });
  created.tickets.push(id);
}

beforeEach(() => {
  jar.clear();
  request.path = null;
});

afterAll(async () => {
  await db.supportTicket.deleteMany({ where: { id: { in: created.tickets } } });
  await db.order.deleteMany({ where: { id: { in: created.orders } } });
});

describe("redirect rules", () => {
  it("send signed-out visitors to sign-in with the admin path and customers to their portal", async () => {
    const session = { id: "s" } as never;
    const { user: customer } = await makeUser();
    expect(adminRedirect(null, "/admin/orders")).toBe("/sign-in?next=%2Fadmin%2Forders");
    expect(adminRedirect({ session, user: customer }, "/admin")).toBe("/account");
    const staff = await makeStaff("SUPPORT", "DEACTIVATED");
    expect(adminRedirect({ session, user: staff }, "/admin")).toBeNull();
  });
});

describe("getAdminState", () => {
  it("redirects a missing or stale session to sign-in, keeping only a safe admin path", async () => {
    request.path = "/admin/orders?filter%5Bstatus%5D=pending";
    expect(await redirectOf(getAdminState())).toBe("/sign-in?next=%2Fadmin%2Forders%3Ffilter%255Bstatus%255D%3Dpending");
    jar.set("axs_session", "not-a-real-session-token");
    request.path = "//evil.example/admin";
    expect(await redirectOf(getAdminState())).toBe("/sign-in?next=%2Fadmin");
  });

  it("sends customers to /account", async () => {
    const { user } = await makeUser();
    await signInAs(user);
    request.path = "/admin";
    expect(await redirectOf(getAdminState())).toBe("/account");
    await expect(getAdminContext()).rejects.toMatchObject({ digest: expect.stringContaining("/account") });
  });

  it("reports staff without live access (invited, no role) as inactive", async () => {
    const invited = await makeStaff("ADMIN", "INVITED");
    const roleless = await db.user.update({ where: { id: (await makeStaff("SUPPORT")).id }, data: { staffRole: null } });
    for (const staff of [invited, roleless]) {
      await signInAs(staff);
      const state = await getAdminState();
      expect(state).toEqual({ kind: "inactive", user: { id: staff.id, name: staff.name, email: staff.email } });
      await expect(getAdminContext()).rejects.toBeInstanceOf(AdminAccessInactiveError);
    }
  });

  it("sends deactivated staff to sign-in (their sessions no longer resolve)", async () => {
    const staff = await makeStaff("ADMIN", "DEACTIVATED");
    await signInAs(staff);
    request.path = "/admin/licenses";
    expect(await redirectOf(getAdminState())).toBe("/sign-in?next=%2Fadmin%2Flicenses");
  });

  it("loads the staff member, the module locks and the permission checks for each role", async () => {
    const env = getEnv();
    for (const role of ["OWNER", "ADMIN", "SUPPORT", "FINANCE"] as const) {
      const staff = await makeStaff(role);
      await signInAs(staff);
      const ctx = await getAdminContext();
      expect(ctx.staff).toEqual({ id: staff.id, name: staff.name, email: staff.email, role });
      expect(ctx.auth.user.id).toBe(staff.id);
      expect(ctx.modules.filter((m) => m.locked).map((m) => m.key)).toEqual(lockedModulesFor(role).map((m) => m.key));
      expect(ctx.testMode).toBe(isPaymentTestMode(env));
      expect(ctx.can("refunds.issue")).toBe(role === "OWNER" || role === "FINANCE");
      expect(ctx.can("licenses.revoke")).toBe(role === "OWNER" || role === "ADMIN");
      expect(ctx.canView("settings")).toBe(role === "OWNER");
      expect(ctx.canView("orders")).toBe(true);
      // The client gets only serializable data: no session, user row or functions.
      const data = toAdminContextData(ctx);
      expect(Object.keys(data).sort()).toEqual(["modules", "staff", "testMode"]);
      expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    }
  });
});

describe("sidebar badges", () => {
  it("count pending + in-review orders and open unassigned tickets", async () => {
    const before = await loadAdminBadges(db, "OWNER");
    const { accountId } = await makeUser();
    const assignee = await makeStaff("SUPPORT");
    if (!accountId) throw new Error("customer without an account");
    await makeOrder("PENDING");
    await makeOrder("REVIEW");
    await makeOrder("PAID");
    await makeOrder("CONFIRMING");
    await makeTicket(accountId, "OPEN", null);
    await makeTicket(accountId, "OPEN", assignee.id);
    await makeTicket(accountId, "AWAITING_CUSTOMER", null);
    const after = await loadAdminBadges(db, "OWNER");
    expect((after.orders ?? 0) - (before.orders ?? 0)).toBe(2);
    expect((after.tickets ?? 0) - (before.tickets ?? 0)).toBe(1);

    const owner = await makeStaff("OWNER");
    await signInAs(owner);
    const ctx = await getAdminContext();
    expect(ctx.modules.find((m) => m.key === "orders")?.badge).toBe(after.orders);
    expect(ctx.modules.find((m) => m.key === "tickets")?.badge).toBe(after.tickets);
    expect(ctx.modules.find((m) => m.key === "products")?.badge).toBe(0);
  });
});

describe("payment test mode", () => {
  it("is on for the mock provider and Razorpay test keys only", () => {
    expect(isPaymentTestMode({ PAYMENT_PROVIDER: "mock", PAYMENT_KEY_ID: undefined })).toBe(true);
    expect(isPaymentTestMode({ PAYMENT_PROVIDER: "razorpay", PAYMENT_KEY_ID: "rzp_test_abc123" })).toBe(true);
    expect(isPaymentTestMode({ PAYMENT_PROVIDER: "razorpay", PAYMENT_KEY_ID: "rzp_live_abc123" })).toBe(false);
    expect(isPaymentTestMode({ PAYMENT_PROVIDER: "razorpay", PAYMENT_KEY_ID: undefined })).toBe(false);
    expect(isPaymentTestMode({ PAYMENT_PROVIDER: "cashfree", PAYMENT_KEY_ID: "TEST123" })).toBe(false);
  });
});
