/**
 * Admin Customers: the business-account list (lifetime value from paid orders net of processed refunds, paid order
 * count, last order, active licenses), filters and search, the drawer detail, and the customers.manage actions
 * (resend verification, password reset) through the auth flows: codes and links are emailed directly, never returned,
 * and each send writes one audit row.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));
const mail = vi.hoisted(() => ({ sent: [] as { to: string; templateId: string; vars: Record<string, string> }[] }));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendAuthEmail: async (input: { to: string; templateId: string; vars: Record<string, string> }) => {
    mail.sent.push(input);
    return { ok: true };
  },
}));

import * as resetRoute from "@/app/api/admin/customers/[id]/password-reset/route";
import * as resendRoute from "@/app/api/admin/customers/[id]/resend-verification/route";
import * as detailRoute from "@/app/api/admin/customers/[id]/route";
import * as exportRoute from "@/app/api/admin/customers/export.csv/route";
import * as listRoute from "@/app/api/admin/customers/route";
import type { AdminCustomerDetail, AdminCustomerRow } from "@/lib/admin/customers/model";
import { sha256Hex } from "@/lib/auth/tokens";
import { db } from "@/lib/db";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers, type TestSession } from "../support/admin-fixtures";
import { uniqueEmail } from "./auth-fixtures";
import { DAY, makeCatalog, makeLicense, makeMember, type Catalog, type Member } from "./license-actions-fixtures";

let callers: AdminCallers;
let catalog: Catalog;
let owner: Member;
let tag: string;

const PAID_AT = new Date("2026-09-20T05:00:00.000Z");
type RefundSeed = { amountPaise: number; status: "PROCESSED" | "PENDING" };

async function order(accountId: string, status: "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "FAILED", totalPaise: number, paidAt: Date | null, refunds: RefundSeed[] = []) {
  const id = `AX-C${randomBytes(4).toString("hex").toUpperCase()}`;
  await db.order.create({
    data: {
      id,
      accountId,
      email: owner.user.email,
      billing: {},
      status,
      subtotalPaise: totalPaise,
      taxablePaise: totalPaise,
      totalPaise,
      placeOfSupply: "Gujarat",
      paidAt,
      items: { create: [{ planId: catalog.annual.id, quantity: 2, unitPricePaise: totalPaise, taxablePaise: totalPaise, taxPaise: 0 }] },
      payments: {
        create: [
          {
            provider: "mock",
            providerOrderId: `mock_${id}`,
            amountPaise: totalPaise,
            status: "CAPTURED",
            refunds: { create: refunds.map((r) => ({ ...r, reason: "Test", createdById: callers.FINANCE.user.id })) },
          },
        ],
      },
    },
  });
  return id;
}

beforeAll(async () => {
  [callers, catalog] = await Promise.all([makeAdminCallers(), makeCatalog()]);
  owner = await makeMember({ name: "Kavita Joshi" });
  tag = randomBytes(4).toString("hex");
  await db.businessAccount.update({
    where: { id: owner.accountId },
    data: { legalName: `Joshi Hardware ${tag}`, gstin: "08ABCDE1234F1Z5", state: "Rajasthan", city: "Jaipur" },
  });
  await makeMember({ accountId: owner.accountId, role: "BILLING", name: "Rohan Joshi" });
  await order(owner.accountId, "PAID", 10_000, new Date("2026-08-01T05:00:00.000Z"));
  const partial: RefundSeed[] = [{ amountPaise: 5_000, status: "PROCESSED" }, { amountPaise: 1_000, status: "PENDING" }];
  await order(owner.accountId, "PARTIALLY_REFUNDED", 20_000, PAID_AT, partial);
  await order(owner.accountId, "REFUNDED", 7_000, new Date("2026-07-01T05:00:00.000Z"));
  await order(owner.accountId, "FAILED", 3_000, null);
  await makeLicense(catalog, { accountId: owner.accountId });
  await makeLicense(catalog, { accountId: owner.accountId, plan: catalog.trial, status: "TRIAL", expiresAt: new Date(Date.now() + 5 * DAY) });
  await makeLicense(catalog, { accountId: owner.accountId, expiresAt: new Date(Date.now() - 5 * DAY) });
  await makeLicense(catalog, { accountId: owner.accountId, status: "REVOKED" });
  await db.supportTicket.create({ data: { id: `T-C${tag}`, accountId: owner.accountId, subject: "Printer setup", status: "OPEN" } });
});

beforeEach(() => {
  mail.sent.length = 0;
});

const list = async (session: TestSession | null, query: string) => callRoute(jar, listRoute.GET, { path: `/api/admin/customers?${query}`, session });
const rowsOf = async (res: Response) => (await res.json()) as { items: AdminCustomerRow[]; total: number };

describe("list", () => {
  it("shows the account through its owner with lifetime value net of processed refunds", async () => {
    const res = await list(callers.FINANCE, `q=${encodeURIComponent(`Joshi Hardware ${tag}`)}`);
    expect(res.status).toBe(200);
    const { items, total } = await rowsOf(res);
    expect(total).toBe(1);
    expect(items[0]).toEqual({
      id: owner.accountId,
      legalName: `Joshi Hardware ${tag}`,
      gstin: "08ABCDE1234F1Z5",
      state: "Rajasthan",
      ownerName: "Kavita Joshi",
      ownerEmail: owner.user.email,
      ownerVerified: true,
      activeLicenses: 2,
      orders: 3,
      lifetimeValuePaise: 10_000 + 15_000,
      lastOrderAt: PAID_AT.toISOString(),
    });
  });

  it("filters by GSTIN registration and state, and finds members by email", async () => {
    const q = `q=${encodeURIComponent(tag)}`;
    expect((await rowsOf(await list(callers.SUPPORT, `${q}&filter[gst]=yes`))).total).toBe(1);
    expect((await rowsOf(await list(callers.SUPPORT, `${q}&filter[gst]=no`))).total).toBe(0);
    expect((await rowsOf(await list(callers.SUPPORT, `${q}&filter[state]=Rajasthan`))).total).toBe(1);
    expect((await rowsOf(await list(callers.SUPPORT, `${q}&filter[state]=Kerala`))).total).toBe(0);
    expect((await rowsOf(await list(callers.SUPPORT, `q=${encodeURIComponent(owner.user.email)}`))).items[0]?.id).toBe(owner.accountId);
    expect((await list(callers.customer, "")).status).toBe(403);
    expect((await list(null, "")).status).toBe(401);
  });

  it("sorts by lifetime value, highest first by default", async () => {
    const { items } = await rowsOf(await list(callers.OWNER, "pageSize=100"));
    const values = items.map((r) => r.lifetimeValuePaise);
    expect(values).toEqual([...values].sort((a, b) => b - a));
  });

  it("exports CSV for Owner and Finance only", async () => {
    const path = `/api/admin/customers/export.csv?q=${encodeURIComponent(tag)}`;
    expect((await callRoute(jar, exportRoute.GET, { path, session: callers.ADMIN })).status).toBe(403);
    const res = await callRoute(jar, exportRoute.GET, { path, session: callers.OWNER });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain(`Joshi Hardware ${tag}`);
    expect(csv).toContain("250.00");
  });
});

describe("detail", () => {
  it("returns the owner, members, licenses, orders and tickets", async () => {
    const path = `/api/admin/customers/${owner.accountId}`;
    const res = await callRoute(jar, detailRoute.GET, { path, params: { id: owner.accountId }, session: callers.FINANCE });
    expect(res.status).toBe(200);
    const { customer } = (await res.json()) as { customer: AdminCustomerDetail };
    expect(customer.owner).toMatchObject({ userId: owner.user.id, name: "Kavita Joshi", role: "OWNER", verified: true, hasPassword: true });
    expect(customer.members.map((m) => m.role)).toEqual(["OWNER", "BILLING"]);
    expect(customer).toMatchObject({ lifetimeValuePaise: 25_000, ordersCount: 3, licensesTotal: 4, ordersTotal: 4, ticketsTotal: 1, city: "Jaipur" });
    expect(customer.licenses.map((l) => l.status).sort()).toEqual(["active", "expired", "revoked", "trial"]);
    expect(customer.orders[0]?.lines).toContain("\u00D7 2");
    expect(customer.tickets[0]).toMatchObject({ subject: "Printer setup", status: "OPEN" });
    const none = await callRoute(jar, detailRoute.GET, { path: "/api/admin/customers/acct-none-0000", params: { id: "acct-none-0000" }, session: callers.FINANCE });
    expect(none.status).toBe(404);
  });
});

const sendAction = (handler: { POST: unknown }, verb: string, accountId: string, session: TestSession | null, body: unknown = {}) =>
  callRoute(jar, handler.POST, { method: "POST", path: `/api/admin/customers/${accountId}/${verb}`, params: { id: accountId }, session, body });
const audits = (accountId: string, action: string) => db.auditLog.findMany({ where: { targetType: "customer", targetId: accountId, action } });

describe("resend verification", () => {
  it("emails a new code to an unverified owner, never returns it and audits the send", async () => {
    const unverified = await makeMember({ verified: false });
    const res = await sendAction(resendRoute, "resend-verification", unverified.accountId, callers.SUPPORT);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ userId: unverified.user.id, email: unverified.user.email, sent: true });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ to: unverified.user.email, templateId: "email_verification" });
    expect(JSON.stringify(body)).not.toContain(mail.sent[0]!.vars.code!);
    expect(await db.authToken.count({ where: { userId: unverified.user.id, type: "EMAIL_VERIFY", usedAt: null } })).toBe(1);
    expect(await audits(unverified.accountId, "Resent verification email")).toHaveLength(1);
  });

  it("refuses verified owners (409), members without a password (409), strangers (422) and Finance (403)", async () => {
    const verified = await sendAction(resendRoute, "resend-verification", owner.accountId, callers.ADMIN);
    expect(verified.status).toBe(409);
    expect(await errorCodeOf(verified)).toBe("already_verified");
    const placeholder = await db.user.create({ data: { email: uniqueEmail("ph"), name: "", kind: "CUSTOMER" } });
    await db.accountMember.create({ data: { accountId: owner.accountId, userId: placeholder.id, role: "VIEWER", status: "INVITED" } });
    const noPassword = await sendAction(resendRoute, "resend-verification", owner.accountId, callers.ADMIN, { userId: placeholder.id });
    expect(await errorCodeOf(noPassword)).toBe("no_password");
    const stranger = await sendAction(resendRoute, "resend-verification", owner.accountId, callers.ADMIN, { userId: callers.customer.user.id });
    expect(stranger.status).toBe(422);
    expect((await sendAction(resendRoute, "resend-verification", owner.accountId, callers.FINANCE)).status).toBe(403);
    expect(mail.sent).toHaveLength(0);
  });
});

describe("password reset", () => {
  it("emails a fresh single-use link (older links stop working), never returns it, and is rate limited", async () => {
    const person = await makeMember();
    const first = await sendAction(resetRoute, "password-reset", person.accountId, callers.SUPPORT);
    expect(first.status).toBe(200);
    const text = await first.text();
    const url = mail.sent[0]?.vars.reset_url ?? "";
    const token = new URL(url).searchParams.get("token") ?? "";
    expect(token).toContain(".");
    expect(text).not.toContain(token);
    const [id, secret] = token.split(".") as [string, string];
    const row = await db.authToken.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ type: "PASSWORD_RESET", userId: person.user.id, usedAt: null, codeHash: sha256Hex(secret) });

    expect((await sendAction(resetRoute, "password-reset", person.accountId, callers.SUPPORT)).status).toBe(200);
    expect((await db.authToken.findUniqueOrThrow({ where: { id } })).usedAt).not.toBeNull();
    expect((await sendAction(resetRoute, "password-reset", person.accountId, callers.SUPPORT)).status).toBe(200);
    const limited = await sendAction(resetRoute, "password-reset", person.accountId, callers.SUPPORT);
    expect(limited.status).toBe(429);
    expect(mail.sent).toHaveLength(3);
    expect(await audits(person.accountId, "Sent password reset")).toHaveLength(3);
  });
});
