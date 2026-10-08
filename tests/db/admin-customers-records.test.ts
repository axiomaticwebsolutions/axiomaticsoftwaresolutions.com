/**
 * Admin records PART A (docs/admin-records-design.md A7, database): staff create customers without a password (a
 * single-use set-password link shown once, emailed directly, never logged or audited), edit their details and email
 * (security epoch, sessions, tokens, notice to the old address), mark emails verified (guest orders claimed) and create
 * set-password links; staff-created customers are never placeholders, and /forgot and /reset serve them.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; templateId: string; vars: Record<string, string> }[], ok: true }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendAuthEmail: async (input: { to: string; templateId: string; vars: Record<string, string> }) => {
    mail.sent.push(input);
    return { ok: mail.ok };
  },
}));

import type { User } from "@/generated/prisma/client";
import * as resetRoute from "@/app/api/admin/customers/[id]/password-reset/route";
import * as detailRoute from "@/app/api/admin/customers/[id]/route";
import * as linkRoute from "@/app/api/admin/customers/[id]/set-password-link/route";
import * as verifyRoute from "@/app/api/admin/customers/[id]/verify-email/route";
import * as createRoute from "@/app/api/admin/customers/route";
import type { AdminCustomerDetail } from "@/lib/admin/customers/model";
import { createCustomer, type CreateCustomerResult } from "@/lib/admin/customers/records";
import { customerCreateBody } from "@/lib/admin/customers/schemas";
import { actorFromStaff } from "@/lib/audit";
import { emailHint, newOpaqueSecret } from "@/lib/auth/flows/common";
import { requestPasswordReset } from "@/lib/auth/flows/forgot-password";
import { registerUser } from "@/lib/auth/flows/register";
import { inspectResetToken, resetPassword } from "@/lib/auth/flows/reset-password";
import { createSession } from "@/lib/auth/sessions";
import { sha256Hex } from "@/lib/auth/tokens";
import { createCheckoutOrder } from "@/lib/checkout/create-order";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { getPaymentProvider } from "@/lib/payments";
import { acceptInvite, issueTeamInvite } from "@/lib/portal/invites";
import { callRoute, errorCodeOf, makeAdminCallers, makeStaff, type AdminCallers, type TestSession } from "../support/admin-fixtures";
import { lastMail, makeOrder, OTHER_PASSWORD, PASSWORD, randomIp, resetTokenIn, uniqueEmail } from "./auth-fixtures";
import { BILLING, buyerOf, orderRequest, seedCatalog, testIp } from "./checkout-fixtures";
import { makeMember } from "./license-actions-fixtures";

const DAY = 86_400_000;
const REASON = "Customer asked on a phone call";
const DOT = "·";

let callers: AdminCallers;
let fixtureStaff: User;

beforeAll(async () => {
  callers = await makeAdminCallers();
  fixtureStaff = await makeStaff("SUPPORT");
});

beforeEach(() => {
  mail.sent.length = 0;
  mail.ok = true;
});

type Json = Record<string, unknown> & { error?: { code: string; message: string } & Record<string, unknown> };
const json = async (res: Response) => (await res.json()) as Json;

const newBody = (over: Record<string, unknown> = {}) => ({ name: "Kavita Joshi", email: uniqueEmail("kavita"), reason: REASON, ...over });

const create = (session: TestSession | null, body: unknown, opts: { csrf?: boolean } = {}) =>
  callRoute(jar, createRoute.POST, { method: "POST", path: "/api/admin/customers", session, body, csrf: opts.csrf });
const patch = (session: TestSession | null, accountId: string, body: unknown) =>
  callRoute(jar, detailRoute.PATCH, { method: "PATCH", path: `/api/admin/customers/${accountId}`, params: { id: accountId }, session, body });
const action = (handler: unknown, verb: string, session: TestSession | null, accountId: string, body: unknown = {}) =>
  callRoute(jar, handler, { method: "POST", path: `/api/admin/customers/${accountId}/${verb}`, params: { id: accountId }, session, body });
const verify = (session: TestSession | null, accountId: string, body: unknown = {}) => action(verifyRoute.POST, "verify-email", session, accountId, body);
const link = (session: TestSession | null, accountId: string, body: unknown = {}) => action(linkRoute.POST, "set-password-link", session, accountId, body);
const detail = async (accountId: string) => {
  const res = await callRoute(jar, detailRoute.GET, { path: `/api/admin/customers/${accountId}`, params: { id: accountId }, session: callers.FINANCE });
  return ((await res.json()) as { customer: AdminCustomerDetail }).customer;
};

/** A staff-created customer through the service (no route rate limit), unverified and without a password. */
async function staffCustomer(over: Record<string, unknown> = {}): Promise<CreateCustomerResult> {
  return createCustomer(customerCreateBody.parse(newBody(over)), { staff: { id: fixtureStaff.id, role: "SUPPORT" }, actor: actorFromStaff(fixtureStaff) });
}

const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";
const tokenRow = (token: string) => db.authToken.findUniqueOrThrow({ where: { id: token.split(".")[0] } });
const audits = (accountId: string, action?: string) =>
  db.auditLog.findMany({ where: { targetType: "customer", targetId: accountId, ...(action ? { action } : {}) }, orderBy: { createdAt: "asc" } });

describe("roles (every new route)", () => {
  it("create: 201 for Owner, Administrator and Support; 403 for Finance and customers; 401 signed out; 403 without CSRF", async () => {
    for (const role of ["OWNER", "ADMIN", "SUPPORT"] as const) expect((await create(callers[role], newBody())).status, role).toBe(201);
    for (const session of [callers.FINANCE, callers.customer]) {
      const res = await create(session, newBody());
      expect(res.status).toBe(403);
      expect(await errorCodeOf(res)).toBe("forbidden");
    }
    expect((await create(null, newBody())).status).toBe(401);
    expect(await errorCodeOf(await create(callers.OWNER, newBody(), { csrf: false }))).toBe("csrf_failed");
  });

  it("edit, verify-email and set-password-link: allowed for Owner, Administrator and Support only", async () => {
    const c = await staffCustomer();
    const phones = { OWNER: "9820011111", ADMIN: "9820022222", SUPPORT: "9820033333" } as const;
    for (const role of ["OWNER", "ADMIN", "SUPPORT"] as const) {
      expect((await patch(callers[role], c.accountId, { phone: phones[role], reason: REASON })).status, `PATCH ${role}`).toBe(200);
      expect((await verify(callers[role], c.accountId, { reason: REASON })).status, `verify ${role}`).toBe(200);
      expect((await link(callers[role], c.accountId, { reason: REASON })).status, `link ${role}`).toBe(201);
    }
    for (const session of [callers.FINANCE, callers.customer]) {
      for (const res of [
        await patch(session, c.accountId, { phone: "9820044444", reason: REASON }),
        await verify(session, c.accountId, { reason: REASON }),
        await link(session, c.accountId, { reason: REASON }),
      ]) {
        expect(res.status).toBe(403);
        expect(await errorCodeOf(res)).toBe("forbidden");
      }
    }
    for (const res of [await patch(null, c.accountId, { phone: "9820044444" }), await verify(null, c.accountId), await link(null, c.accountId)]) {
      expect(res.status).toBe(401);
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: c.userId } })).phone).toBe(phones.SUPPORT);
  });
});

describe("create customer", () => {
  it("creates the user without a password, the account they own and a 7-day set-password link shown once", async () => {
    const logged: string[] = [];
    const spies = (["info", "warn", "error"] as const).map((level) =>
      vi.spyOn(log, level).mockImplementation((event: string, fields?: unknown) => {
        logged.push(JSON.stringify([event, fields ?? null]));
      }),
    );
    try {
      const body = newBody({
        phone: "+91 98200 12345",
        legalName: "Joshi Hardware",
        gstin: "08abcde1234f1z5",
        state: "Rajasthan",
        city: "Jaipur",
        address: "4 MI Road",
        pin: "302001",
      });
      const before = Date.now();
      const res = await create(callers.SUPPORT, body);
      expect(res.status).toBe(201);
      expect(res.headers.get("cache-control")).toContain("no-store");
      const out = (await res.json()) as CreateCustomerResult;
      expect(out).toMatchObject({ email: body.email, emailVerified: false, claimedOrders: 0, emailSent: true });
      const url = new URL(out.setPassword.url);
      expect(url.pathname).toBe("/reset");
      const token = tokenOf(out.setPassword.url);
      const secret = token.split(".")[1] ?? "";
      expect(secret.length).toBeGreaterThanOrEqual(32);

      const user = await db.user.findUniqueOrThrow({ where: { id: out.userId } });
      expect(user).toMatchObject({
        kind: "CUSTOMER",
        email: body.email,
        name: "Kavita Joshi",
        phone: "9820012345",
        passwordHash: null,
        emailVerifiedAt: null,
        createdByStaffId: callers.SUPPORT.user.id,
      });
      const account = await db.businessAccount.findUniqueOrThrow({ where: { id: out.accountId }, include: { members: true } });
      expect(account).toMatchObject({ legalName: "Joshi Hardware", gstin: "08ABCDE1234F1Z5", state: "Rajasthan", city: "Jaipur", address: "4 MI Road", pin: "302001" });
      expect(account.members).toEqual([expect.objectContaining({ userId: user.id, role: "OWNER", status: "ACTIVE", invitedAt: null })]);

      const row = await tokenRow(token);
      expect(row).toMatchObject({ type: "PASSWORD_RESET", userId: user.id, email: body.email, usedAt: null, codeHash: sha256Hex(secret) });
      expect(row.codeHash).not.toContain(secret);
      expect(row.meta).toEqual({ purpose: "set_password", issuedById: callers.SUPPORT.user.id });
      expect(row.expiresAt.toISOString()).toBe(out.setPassword.expiresAt);
      expect(Math.abs(row.expiresAt.getTime() - (before + 7 * DAY))).toBeLessThan(60_000);

      expect(mail.sent).toHaveLength(1);
      expect(mail.sent[0]).toMatchObject({
        to: body.email,
        templateId: "set_password",
        vars: { set_password_url: out.setPassword.url, expires_in: "7 days", business_name: "Joshi Hardware", customer_name: "Kavita Joshi" },
      });

      const rows = await audits(out.accountId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "Created customer", target: body.email, actorId: callers.SUPPORT.user.id, actorRole: "support", reason: REASON });
      expect(rows[0]?.detail).toBe(`Joshi Hardware ${DOT} fields: name, email, phone, legalName, gstin, address, city, state, pin`);
      const auditText = JSON.stringify(await db.auditLog.findMany({ where: { createdAt: { gte: new Date(before - 1000) } } }));
      expect(auditText).not.toContain("token=");
      expect(auditText).not.toContain(secret);
      expect(logged.some((line) => line.includes("admin_customer_created"))).toBe(true);
      expect(logged.join("\n")).not.toContain(secret);
      expect(logged.join("\n")).not.toContain("token=");

      const activity = await db.accountActivity.findMany({ where: { accountId: out.accountId } });
      expect(activity).toEqual([expect.objectContaining({ actorId: null, actorName: "Axiomatic team", action: "Created account", target: "Joshi Hardware", kind: "team" })]);
      expect((await detail(out.accountId)).owner).toMatchObject({ createdByStaff: true, canSetPassword: true, hasPassword: false, verified: false });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("uses the person's name for the business, and needs a reason before anything is stored", async () => {
    const out = (await (await create(callers.ADMIN, newBody({ name: "Arjun Mehta" }))).json()) as CreateCustomerResult;
    expect((await db.businessAccount.findUniqueOrThrow({ where: { id: out.accountId } })).legalName).toBe("Arjun Mehta");
    const email = uniqueEmail("noreason");
    for (const reason of [undefined, "no"]) {
      const res = await create(callers.ADMIN, { name: "No Reason", email, ...(reason ? { reason } : {}) });
      expect(res.status).toBe(422);
      expect(await errorCodeOf(res)).toBe("reason_required");
    }
    expect(await db.user.count({ where: { email } })).toBe(0);
    expect(mail.sent.filter((m) => m.to === email)).toEqual([]);
  });

  it("answers 409 email_taken for an existing customer (with their account), case and space variants and staff addresses", async () => {
    const existing = await makeMember({ name: "Rohan Joshi" });
    const dup = await json(await create(callers.ADMIN, newBody({ email: existing.user.email })));
    expect(dup.error).toMatchObject({
      code: "email_taken",
      message: "A customer with this email already exists.",
      accountId: existing.accountId,
      fieldErrors: { email: ["A customer with this email already exists."] },
    });
    const variant = await create(callers.ADMIN, newBody({ email: `  ${existing.user.email.toUpperCase()} ` }));
    expect(variant.status).toBe(409);
    expect(await errorCodeOf(variant)).toBe("email_taken");
    const staff = await json(await create(callers.ADMIN, newBody({ email: callers.FINANCE.user.email })));
    expect(staff.error).toMatchObject({ code: "email_taken", message: "This email belongs to a staff account." });
    expect(staff.error?.accountId).toBeUndefined();
    expect(await db.user.count({ where: { email: existing.user.email } })).toBe(1);
    expect(await db.accountMember.count({ where: { userId: existing.user.id } })).toBe(1);
  });

  it("takes over a team-invite placeholder of the address and leaves the invitation pending", async () => {
    const inviter = await makeMember();
    const email = uniqueEmail("invited");
    const placeholder = await db.user.create({ data: { kind: "CUSTOMER", email, name: "", passwordHash: null } });
    const invite = await db.accountMember.create({
      data: { accountId: inviter.accountId, userId: placeholder.id, role: "VIEWER", status: "INVITED", invitedAt: new Date() },
    });
    const res = await create(callers.OWNER, newBody({ email }));
    expect(res.status).toBe(201);
    const out = (await res.json()) as CreateCustomerResult;
    expect(out.userId).toBe(placeholder.id);
    const user = await db.user.findUniqueOrThrow({ where: { id: placeholder.id }, include: { memberships: true } });
    expect(user).toMatchObject({ name: "Kavita Joshi", passwordHash: null, createdByStaffId: callers.OWNER.user.id });
    expect(user.memberships.find((m) => m.id === invite.id)).toMatchObject({ accountId: inviter.accountId, status: "INVITED" });
    expect(user.memberships.find((m) => m.id !== invite.id)).toMatchObject({ accountId: out.accountId, role: "OWNER", status: "ACTIVE", invitedAt: null });
  });

  it("with 'Email already verified' marks the email verified and moves the address's guest orders in", async () => {
    const email = uniqueEmail("guest");
    const { order, licenseId } = await makeOrder(email, { withLicense: true });
    const res = await create(callers.SUPPORT, newBody({ email, emailVerified: true }));
    expect(res.status).toBe(201);
    const out = (await res.json()) as CreateCustomerResult;
    expect(out).toMatchObject({ emailVerified: true, claimedOrders: 1 });
    expect((await db.user.findUniqueOrThrow({ where: { id: out.userId } })).emailVerifiedAt).not.toBeNull();
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).accountId).toBe(out.accountId);
    expect((await db.license.findUniqueOrThrow({ where: { id: licenseId ?? "" } })).accountId).toBe(out.accountId);
    // The audit row lists what moved (review fix): staff verification hands the address's purchases to this account.
    expect((await audits(out.accountId, "Created customer"))[0]?.detail).toMatch(
      new RegExp(`email marked verified ${DOT} 1 guest order moved to this account: ${order.id}$`),
    );
  });

  it("refuses 'verified' for a role without customers.verify_email (service guard) and stores nothing", async () => {
    const email = uniqueEmail("forged");
    const finance = callers.FINANCE.user;
    await expect(
      createCustomer(customerCreateBody.parse(newBody({ email, emailVerified: true })), { staff: { id: finance.id, role: "FINANCE" }, actor: actorFromStaff(finance) }),
    ).rejects.toMatchObject({ status: 403, code: "forbidden" });
    expect(await db.user.count({ where: { email } })).toBe(0);
  });

  it("still creates the customer when the email cannot be sent, and returns the link", async () => {
    mail.ok = false;
    const res = await create(callers.OWNER, newBody());
    expect(res.status).toBe(201);
    const out = (await res.json()) as CreateCustomerResult;
    expect(out.emailSent).toBe(false);
    expect(out.setPassword.url).toContain("/reset?token=");
    expect((await tokenRow(tokenOf(out.setPassword.url))).usedAt).toBeNull();
  });
});

describe("staff-created customers are never placeholders", () => {
  it("registering the address answers 409 email_taken and leaves the user as it was", async () => {
    const c = await staffCustomer();
    const before = await db.user.findUniqueOrThrow({ where: { id: c.userId } });
    await expect(
      registerUser({ name: "Mallory", email: c.email, password: PASSWORD, businessName: undefined, next: undefined }, { ip: randomIp(), userAgent: "Vitest" }),
    ).rejects.toMatchObject({ status: 409, code: "email_taken" });
    expect(await db.user.findUniqueOrThrow({ where: { id: c.userId } })).toEqual(before);
    expect(await db.accountMember.count({ where: { userId: c.userId } })).toBe(1);
  });

  it("checkout 'Create an account' with the address answers 409 email_taken", async () => {
    const c = await staffCustomer();
    const cat = await seedCatalog();
    const before = await db.user.findUniqueOrThrow({ where: { id: c.userId } });
    await expect(
      createCheckoutOrder(
        db,
        orderRequest({ items: [{ planId: cat.plans.annual.id, qty: 1 }], billing: { ...BILLING, email: c.email }, createAccount: { password: "s3cure-pass" } }),
        { buyer: await buyerOf(null), ip: testIp(), provider: getPaymentProvider("mock") },
      ),
    ).rejects.toMatchObject({ status: 409, code: "email_taken" });
    expect(await db.user.findUniqueOrThrow({ where: { id: c.userId } })).toEqual(before);
    expect(await db.order.count({ where: { email: c.email } })).toBe(0);
  });
});

describe("set-password links on /reset", () => {
  it("set the first password once, bump the epoch and leave the email unverified", async () => {
    const c = await staffCustomer();
    const token = tokenOf(c.setPassword.url);
    expect(await inspectResetToken(token)).toEqual({ email: c.email, mode: "set" });
    const before = await db.user.findUniqueOrThrow({ where: { id: c.userId } });
    await resetPassword({ token, password: OTHER_PASSWORD }, { ip: randomIp(), userAgent: "Vitest" });
    const after = await db.user.findUniqueOrThrow({ where: { id: c.userId } });
    expect(after.passwordHash).toMatch(/^[$]argon2id[$]/);
    expect(after.securityEpoch).toBe(before.securityEpoch + 1);
    expect(after.emailVerifiedAt).toBeNull();
    await expect(resetPassword({ token, password: PASSWORD }, { ip: randomIp(), userAgent: "Vitest" })).rejects.toMatchObject({ code: "token_invalid" });
    expect((await detail(c.accountId)).owner).toMatchObject({ hasPassword: true, canSetPassword: false });
  });

  it("a normal reset link reads 'reset'; a set-password link for someone who has a password is invalid", async () => {
    const member = await makeMember();
    await requestPasswordReset({ email: member.user.email }, { ip: randomIp(), userAgent: "Vitest" });
    const reset = resetTokenIn(lastMail(mail.sent, member.user.email, "password_reset"));
    expect((await inspectResetToken(reset)).mode).toBe("reset");
    const { secret, hash } = newOpaqueSecret();
    const row = await db.authToken.create({
      data: { type: "PASSWORD_RESET", userId: member.user.id, email: member.user.email, codeHash: hash, expiresAt: new Date(Date.now() + DAY), meta: { purpose: "set_password" } },
    });
    await expect(inspectResetToken(`${row.id}.${secret}`)).rejects.toMatchObject({ code: "token_invalid" });
  });
});

describe("/forgot", () => {
  it("sends a staff-created customer without a password a 30-minute set-password link", async () => {
    const c = await staffCustomer();
    mail.sent.length = 0;
    const now = new Date();
    expect((await requestPasswordReset({ email: c.email }, { ip: randomIp(), userAgent: "Vitest", now })).issued).toBe(true);
    const sent = lastMail(mail.sent, c.email, "set_password");
    expect(sent.vars.expires_in).toBe("30 minutes");
    const row = await tokenRow(tokenOf(sent.vars.set_password_url ?? ""));
    expect(row.meta).toEqual({ purpose: "set_password" });
    expect(row.expiresAt.getTime() - now.getTime()).toBe(30 * 60_000);
    // The staff link from creation stopped working.
    expect((await tokenRow(tokenOf(c.setPassword.url))).usedAt).not.toBeNull();
  });

  it("still sends nothing to sample users and team-invite placeholders without a password", async () => {
    const sample = await db.user.create({ data: { kind: "CUSTOMER", email: uniqueEmail("sample"), name: "Sample", passwordHash: null, emailVerifiedAt: new Date() } });
    const placeholder = await db.user.create({ data: { kind: "CUSTOMER", email: uniqueEmail("ph"), name: "", passwordHash: null } });
    for (const user of [sample, placeholder]) {
      expect((await requestPasswordReset({ email: user.email }, { ip: randomIp(), userAgent: "Vitest" })).issued).toBe(false);
      expect(await db.authToken.count({ where: { userId: user.id } })).toBe(0);
    }
    expect(mail.sent).toEqual([]);
  });
});

describe("edit customer", () => {
  it("needs a reason first (422) and changes nothing", async () => {
    const m = await makeMember({ name: "Kavita" });
    for (const body of [{ name: "Changed" }, { name: "Changed", reason: "no" }]) {
      const res = await patch(callers.SUPPORT, m.accountId, body);
      expect(res.status).toBe(422);
      expect(await errorCodeOf(res)).toBe("reason_required");
    }
    expect((await db.user.findUniqueOrThrow({ where: { id: m.user.id } })).name).toBe("Kavita");
    expect(await audits(m.accountId)).toEqual([]);
  });

  it("name and mobile only: no epoch bump, sessions kept, field names audited", async () => {
    const m = await makeMember({ name: "Kavita" });
    const { session } = await createSession(db, { userId: m.user.id, kind: "CUSTOMER", activeAccountId: m.accountId });
    const res = await patch(callers.SUPPORT, m.accountId, { name: "Kavita Joshi", phone: "98200 12345", reason: REASON });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { customer: AdminCustomerDetail; changed: boolean; signedOut: number };
    expect(out).toMatchObject({ changed: true, signedOut: 0 });
    expect(out.customer.owner).toMatchObject({ name: "Kavita Joshi", phone: "9820012345" });
    const user = await db.user.findUniqueOrThrow({ where: { id: m.user.id } });
    expect(user.securityEpoch).toBe(m.user.securityEpoch);
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).revokedAt).toBeNull();
    const rows = await audits(m.accountId, "Updated customer");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: m.user.email, reason: REASON, detail: "Changed: name, phone" });
  });

  it("business details: the GSTIN/state rule on the merged details, then an activity entry by the Axiomatic team", async () => {
    const m = await makeMember();
    const needsState = await json(await patch(callers.ADMIN, m.accountId, { gstin: "08ABCDE1234F1Z5", reason: REASON }));
    expect(needsState.error).toMatchObject({ code: "validation_failed", fieldErrors: { state: [expect.any(String)] } });
    const otherState = await json(await patch(callers.ADMIN, m.accountId, { gstin: "08ABCDE1234F1Z5", state: "Kerala", reason: REASON }));
    expect(otherState.error).toMatchObject({ code: "validation_failed", fieldErrors: { gstin: [expect.stringContaining("Rajasthan")] } });
    const ok = await patch(callers.ADMIN, m.accountId, { gstin: "08abcde1234f1z5", state: "Rajasthan", city: "Jaipur", reason: REASON });
    expect(ok.status).toBe(200);
    expect(await db.businessAccount.findUniqueOrThrow({ where: { id: m.accountId } })).toMatchObject({ gstin: "08ABCDE1234F1Z5", state: "Rajasthan", city: "Jaipur" });
    const activity = await db.accountActivity.findMany({ where: { accountId: m.accountId } });
    expect(activity).toEqual([expect.objectContaining({ actorId: null, actorName: "Axiomatic team", action: "Updated billing details", kind: "billing" })]);
    expect((await audits(m.accountId, "Updated customer"))[0]?.detail).toBe("Changed: gstin, city, state");
  });

  it("email change: epoch +1, every session ends, open tokens die, verification cleared, the old address is told", async () => {
    const m = await makeMember({ name: "Kavita Joshi" });
    const s1 = await createSession(db, { userId: m.user.id, kind: "CUSTOMER", activeAccountId: m.accountId });
    const s2 = await createSession(db, { userId: m.user.id, kind: "CUSTOMER", activeAccountId: m.accountId });
    const future = new Date(Date.now() + DAY);
    for (const type of ["EMAIL_VERIFY", "PASSWORD_RESET", "LOGIN_OTP"] as const) {
      await db.authToken.create({ data: { type, userId: m.user.id, email: m.user.email, codeHash: `x-${type}`, expiresAt: future } });
    }
    const newEmail = uniqueEmail("moved");
    const res = await patch(callers.SUPPORT, m.accountId, { email: newEmail.toUpperCase(), reason: REASON });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { changed: boolean; signedOut: number };
    expect(out).toEqual(expect.objectContaining({ changed: true, signedOut: 2 }));
    const user = await db.user.findUniqueOrThrow({ where: { id: m.user.id } });
    expect(user).toMatchObject({ email: newEmail, emailVerifiedAt: null, securityEpoch: m.user.securityEpoch + 1 });
    for (const s of [s1, s2]) expect((await db.session.findUniqueOrThrow({ where: { id: s.session.id } })).revokedAt).not.toBeNull();
    expect(await db.authToken.count({ where: { userId: m.user.id, usedAt: null } })).toBe(0);
    const notices = await db.outboxEmail.findMany({ where: { templateId: "account_email_changed", to: m.user.email } });
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain(emailHint(newEmail));
    expect(notices[0]?.text).not.toContain(newEmail);
    const rows = await audits(m.accountId, "Updated customer");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.target).toBe(newEmail);
    expect(rows[0]?.detail).toBe(`Changed: email ${DOT} email was ${emailHint(m.user.email)} ${DOT} signed out of 2 sessions ${DOT} verification cleared`);
    expect(rows[0]?.detail).not.toContain(m.user.email);
  });

  it("email change ticked verified: verified at once and the new address's guest orders move in", async () => {
    const m = await makeMember({ verified: false });
    const newEmail = uniqueEmail("verified");
    const { order } = await makeOrder(newEmail);
    const res = await patch(callers.OWNER, m.accountId, { email: newEmail, emailVerified: true, reason: REASON });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: true, claimedOrders: 1 });
    expect((await db.user.findUniqueOrThrow({ where: { id: m.user.id } })).emailVerifiedAt).not.toBeNull();
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).accountId).toBe(m.accountId);
    expect((await audits(m.accountId, "Updated customer"))[0]?.detail).toMatch(
      new RegExp(`verified by staff ${DOT} 1 guest order moved to this account: ${order.id}$`),
    );
  });

  it("voids team invitations mailed to the old address: their link can't set the new address's password (review fix)", async () => {
    const inviter = await makeMember({ name: "Rohan Joshi" });
    const typo = uniqueEmail("typo");
    const placeholder = await db.user.create({ data: { kind: "CUSTOMER", email: typo, name: "", passwordHash: null } });
    await db.accountMember.create({ data: { accountId: inviter.accountId, userId: placeholder.id, role: "VIEWER", status: "INVITED", invitedAt: new Date() } });
    const invite = await db.$transaction((tx) =>
      issueTeamInvite(tx, {
        accountId: inviter.accountId,
        accountName: "Joshi Traders",
        invitee: { id: placeholder.id, email: typo },
        role: "VIEWER",
        inviter: { id: inviter.user.id, name: inviter.user.name },
        now: new Date(),
      }),
    );
    const token = new URL(invite.email.vars.invite_url ?? "").searchParams.get("token") ?? "";
    const created = (await (await create(callers.OWNER, newBody({ email: typo }))).json()) as CreateCustomerResult;
    expect(created.userId).toBe(placeholder.id);

    const res = await patch(callers.SUPPORT, created.accountId, { email: uniqueEmail("real"), reason: REASON });
    expect(res.status).toBe(200);
    expect((await db.authToken.findUniqueOrThrow({ where: { id: invite.tokenId } })).usedAt).not.toBeNull();
    await expect(acceptInvite({ token, name: "Mallory", password: PASSWORD }, { current: null, ip: null, userAgent: null })).rejects.toMatchObject({
      status: 410,
      code: "invite_revoked",
    });
    const user = await db.user.findUniqueOrThrow({ where: { id: placeholder.id } });
    expect([user.passwordHash, user.emailVerifiedAt]).toEqual([null, null]);
    expect((await audits(created.accountId, "Updated customer"))[0]?.detail).toContain(`${DOT} 1 team invitation voided`);
  });

  it("refuses a team invitation link whose address is no longer the person's, even while the token is open", async () => {
    const inviter = await makeMember();
    const email = uniqueEmail("moved-invitee");
    const invitee = await db.user.create({ data: { kind: "CUSTOMER", email, name: "", passwordHash: null } });
    await db.accountMember.create({ data: { accountId: inviter.accountId, userId: invitee.id, role: "VIEWER", status: "INVITED", invitedAt: new Date() } });
    const invite = await db.$transaction((tx) =>
      issueTeamInvite(tx, {
        accountId: inviter.accountId,
        accountName: "Sharma Medicals",
        invitee: { id: invitee.id, email },
        role: "VIEWER",
        inviter: { id: inviter.user.id, name: inviter.user.name },
        now: new Date(),
      }),
    );
    await db.user.update({ where: { id: invitee.id }, data: { email: uniqueEmail("elsewhere") } });
    const token = new URL(invite.email.vars.invite_url ?? "").searchParams.get("token") ?? "";
    await expect(acceptInvite({ token, name: "Mallory", password: PASSWORD }, { current: null, ip: null, userAgent: null })).rejects.toMatchObject({
      status: 410,
      code: "invite_revoked",
    });
    expect((await db.user.findUniqueOrThrow({ where: { id: invitee.id } })).passwordHash).toBeNull();
  });

  it("refuses a taken email (409), 'verified' without an email change (422) and person fields without an owner (409)", async () => {
    const m = await makeMember();
    const other = await makeMember();
    const taken = await json(await patch(callers.SUPPORT, m.accountId, { email: other.user.email, reason: REASON }));
    expect(taken.error).toMatchObject({ code: "email_taken", message: "This email is already used by another account." });
    const same = await json(await patch(callers.SUPPORT, m.accountId, { email: m.user.email, emailVerified: true, reason: REASON }));
    expect(same.error).toMatchObject({ code: "validation_failed", fieldErrors: { emailVerified: ["Tick this only when you change the email."] } });
    const ownerless = await db.businessAccount.create({ data: { legalName: "No Owner Traders" } });
    expect(await errorCodeOf(await patch(callers.SUPPORT, ownerless.id, { name: "Someone", reason: REASON }))).toBe("no_owner");
    expect((await patch(callers.SUPPORT, ownerless.id, { city: "Pune", reason: REASON })).status).toBe(200);
    expect((await patch(callers.SUPPORT, "acct-none-0000", { city: "Pune", reason: REASON })).status).toBe(404);
    expect((await db.user.findUniqueOrThrow({ where: { id: m.user.id } })).email).toBe(m.user.email);
  });

  it("a no-op answers changed: false and writes nothing", async () => {
    const m = await makeMember({ name: "Kavita Joshi" });
    const res = await patch(callers.ADMIN, m.accountId, { name: "Kavita Joshi", email: m.user.email, reason: REASON });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: false, signedOut: 0 });
    expect(await audits(m.accountId)).toEqual([]);
    expect(await db.accountActivity.count({ where: { accountId: m.accountId } })).toBe(0);
  });
});

describe("mark email as verified", () => {
  it("checks the reason before anything else", async () => {
    const verified = await makeMember();
    for (const accountId of [verified.accountId, "acct-none-0000"]) {
      const res = await verify(callers.SUPPORT, accountId, {});
      expect(res.status).toBe(422);
      expect(await errorCodeOf(res)).toBe("reason_required");
    }
  });

  it("verifies once, voids open codes and claims guest orders; a second call changes nothing", async () => {
    const m = await makeMember({ verified: false });
    const code = await db.authToken.create({
      data: { type: "EMAIL_VERIFY", userId: m.user.id, email: m.user.email, codeHash: "x", expiresAt: new Date(Date.now() + DAY) },
    });
    const { order } = await makeOrder(m.user.email);
    const first = await verify(callers.SUPPORT, m.accountId, { reason: REASON });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ userId: m.user.id, email: m.user.email, changed: true, claimedOrders: 1 });
    expect((await db.user.findUniqueOrThrow({ where: { id: m.user.id } })).emailVerifiedAt).not.toBeNull();
    expect((await db.authToken.findUniqueOrThrow({ where: { id: code.id } })).usedAt).not.toBeNull();
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).accountId).toBe(m.accountId);
    const rows = await audits(m.accountId, "Marked email as verified");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: m.user.email, reason: REASON, actorId: callers.SUPPORT.user.id });
    expect(rows[0]?.detail).toMatch(new RegExp(` ${DOT} 1 guest order moved to this account: ${order.id}$`));

    const again = await verify(callers.ADMIN, m.accountId, { reason: REASON });
    expect(await again.json()).toEqual({ userId: m.user.id, email: m.user.email, changed: false, claimedOrders: 0 });
    expect(await audits(m.accountId, "Marked email as verified")).toHaveLength(1);
  });

  it("refuses an invited member (409 member_invited), a non-member (422) and an account without an owner (409)", async () => {
    const owner = await makeMember();
    const placeholder = await db.user.create({ data: { kind: "CUSTOMER", email: uniqueEmail("ph"), name: "", passwordHash: null } });
    await db.accountMember.create({ data: { accountId: owner.accountId, userId: placeholder.id, role: "VIEWER", status: "INVITED", invitedAt: new Date() } });
    expect(await errorCodeOf(await verify(callers.SUPPORT, owner.accountId, { reason: REASON, userId: placeholder.id }))).toBe("member_invited");
    expect((await verify(callers.SUPPORT, owner.accountId, { reason: REASON, userId: callers.customer.user.id })).status).toBe(422);
    const ownerless = await db.businessAccount.create({ data: { legalName: "No Owner Traders" } });
    expect(await errorCodeOf(await verify(callers.SUPPORT, ownerless.id, { reason: REASON }))).toBe("no_owner");
    expect((await db.user.findUniqueOrThrow({ where: { id: placeholder.id } })).emailVerifiedAt).toBeNull();
  });
});

describe("set-password link", () => {
  it("returns a new single-use link once (201) for an owner without a password; older links stop working", async () => {
    const c = await staffCustomer();
    mail.sent.length = 0;
    const res = await link(callers.SUPPORT, c.accountId, { reason: REASON });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const out = (await res.json()) as { userId: string; email: string; url: string; expiresAt: string; emailSent: boolean };
    expect(out).toMatchObject({ userId: c.userId, email: c.email, emailSent: true });
    const token = tokenOf(out.url);
    expect((await tokenRow(tokenOf(c.setPassword.url))).usedAt).not.toBeNull();
    expect(await tokenRow(token)).toMatchObject({ usedAt: null, meta: { purpose: "set_password", issuedById: callers.SUPPORT.user.id } });
    expect(mail.sent).toEqual([expect.objectContaining({ to: c.email, templateId: "set_password", vars: expect.objectContaining({ set_password_url: out.url }) })]);
    const rows = await audits(c.accountId, "Created set-password link");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ target: c.email, reason: REASON });
    expect(rows[0]?.detail).toMatch(/expires \d{1,2} [A-Z][a-z]{2} \d{4}$/);
    expect(JSON.stringify(rows)).not.toContain(token.split(".")[1] ?? "-");
  });

  it("refuses an owner with a password (409 has_password) and an invited placeholder (409 member_invited)", async () => {
    const m = await makeMember();
    expect(await json(await link(callers.SUPPORT, m.accountId, { reason: REASON }))).toMatchObject({
      error: { code: "has_password", message: "This person already has a password. Send a password reset instead." },
    });
    const placeholder = await db.user.create({ data: { kind: "CUSTOMER", email: uniqueEmail("ph"), name: "", passwordHash: null } });
    await db.accountMember.create({ data: { accountId: m.accountId, userId: placeholder.id, role: "VIEWER", status: "INVITED", invitedAt: new Date() } });
    expect(await errorCodeOf(await link(callers.SUPPORT, m.accountId, { reason: REASON, userId: placeholder.id }))).toBe("member_invited");
    expect(await errorCodeOf(await link(callers.SUPPORT, m.accountId, {}))).toBe("reason_required");
    expect(mail.sent).toEqual([]);
  });

  it("allows 5 links an hour per person, then 429", async () => {
    const c = await staffCustomer();
    for (let i = 0; i < 5; i++) expect((await link(callers.ADMIN, c.accountId, { reason: REASON })).status, `link ${i + 1}`).toBe(201);
    const limited = await link(callers.ADMIN, c.accountId, { reason: REASON });
    expect(limited.status).toBe(429);
    expect(await db.authToken.count({ where: { userId: c.userId, type: "PASSWORD_RESET", usedAt: null } })).toBe(1);
  });
});

describe("existing customer email actions", () => {
  it("password reset for a staff-created customer without a password points to the set-password link", async () => {
    const c = await staffCustomer();
    mail.sent.length = 0;
    const res = await action(resetRoute.POST, "password-reset", callers.SUPPORT, c.accountId);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({
      error: { code: "no_password", message: "This person hasn’t set a password yet. Create a set-password link instead." },
    });
    expect(mail.sent).toEqual([]);
  });
});
