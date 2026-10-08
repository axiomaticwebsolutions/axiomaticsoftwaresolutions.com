/**
 * Admin records PART B (docs/admin-records-design.md B12.3, database): correcting the billing details of a paid order
 * issues, in one transaction, a credit note for the full invoice and a new invoice from their gap-free series, linked
 * through InvoiceCorrection; amounts, items, licenses and payments stay untouched; state, email and other-state GSTINs
 * are refused; corrections chain; both documents download for staff and the customer; reports count the cancelled
 * original in its month and net the correction month to zero.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

import type { User } from "@/generated/prisma/client";
import * as adminNoteRoute from "@/app/api/admin/orders/[id]/credit-notes/[noteId]/route";
import * as correctRoute from "@/app/api/admin/orders/[id]/correct-billing/route";
import * as customerNoteRoute from "@/app/api/orders/[id]/credit-notes/[noteId]/route";
import { correctOrderBilling } from "@/lib/admin/orders/correction";
import { issueOrderRefund } from "@/lib/admin/orders/refund";
import { billingCorrectionBody } from "@/lib/admin/orders/schemas";
import { creditNotesInWindow, invoicesByMonth } from "@/lib/admin/reports/queries";
import { buildReportExport } from "@/lib/admin/reports/exports";
import { monthlyRows } from "@/lib/admin/reports/service";
import { actorFromStaff } from "@/lib/audit";
import { getSettings } from "@/lib/config";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { loadInvoiceModel } from "@/lib/invoice/load";
import { signOrderToken } from "@/lib/orders/token";
import { getPaymentProvider } from "@/lib/payments";
import { callRoute, errorCodeOf, makeAdminCallers, makeStaff, startSession, type AdminCallers, type TestSession } from "../support/admin-fixtures";
import { makeOrdersAccount, makeOrdersCatalog, paidOrder, placeOrder, processRefund, type OrdersCatalog, type PaidOrder, type TestAccount } from "./admin-orders-fixtures";

const REASON = "Customer sent their GSTIN after paying";
/** Maharashtra GSTIN (state code 27), like the seller and the orders' place of supply. */
const MH_GSTIN = "27ABCDE1234F1Z5";
let callers: AdminCallers;
let cat: OrdersCatalog;
let account: TestAccount;
let finance: User;

beforeAll(async () => {
  callers = await makeAdminCallers();
  cat = await makeOrdersCatalog();
  account = await makeOrdersAccount();
  finance = await makeStaff("FINANCE");
});

const ctx = (now?: Date) => ({ staff: { id: finance.id, role: "FINANCE" as const }, actor: actorFromStaff(finance), ...(now ? { now } : {}) });
const correct = (session: TestSession | null, orderId: string, payload: unknown) =>
  callRoute(jar, correctRoute.POST, { method: "POST", path: `/api/admin/orders/${orderId}/correct-billing`, params: { id: orderId }, session, body: payload });
const paid = (at?: Date) => paidOrder({ accountId: account.accountId, items: [{ plan: cat.plans.annual }, { plan: cat.plans.oneTime }] }, at);
const runNo = (no: string) => Number(no.split("/").pop());
const fyOf = (no: string) => no.split("/")[1];

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const e = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
}

async function snapshot(order: PaidOrder) {
  const [row, licenses, payments, items] = await Promise.all([
    db.order.findUniqueOrThrow({ where: { id: order.id } }),
    db.license.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" } }),
    db.payment.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" } }),
    db.orderItem.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" } }),
  ]);
  const { billing: _billing, updatedAt: _updatedAt, ...rest } = row;
  return { order: rest, licenses, payments, items };
}

describe("roles", () => {
  it("Owner and Finance only", async () => {
    const order = await paid();
    for (const session of [callers.ADMIN, callers.SUPPORT, callers.customer]) {
      const res = await correct(session, order.id, { billing: { gstin: MH_GSTIN }, reason: REASON });
      expect([res.status, await errorCodeOf(res)]).toEqual([403, "forbidden"]);
    }
    expect((await correct(null, order.id, { billing: {} })).status).toBe(401);
    expect((await correct(callers.OWNER, order.id, { billing: { gstin: MH_GSTIN }, reason: REASON })).status).toBe(201);
  });
});

describe("a billing correction", () => {
  it("issues a credit note and a new invoice from gap-free series and leaves amounts, licenses and payments untouched", async () => {
    const order = await paid();
    const settings = await getSettings(db);
    const before = await snapshot(order);
    const original = await db.invoice.findUniqueOrThrow({ where: { orderId: order.id } });
    const originalBilling = before.order;

    const res = await correct(callers.FINANCE, order.id, { billing: { gstin: MH_GSTIN, address: "Unit 7, FC Road" }, reason: REASON });
    expect(res.status).toBe(201);
    const { correction } = (await res.json()) as { correction: { id: string; creditNoteNo: string; newInvoiceNo: string; originalInvoiceNo: string } };
    expect(correction.creditNoteNo.startsWith(`${settings.tax.creditNotePrefix}/`)).toBe(true);
    expect(correction.newInvoiceNo.startsWith(`${settings.tax.invoicePrefix}/`)).toBe(true);
    expect(correction.originalInvoiceNo).toBe(original.number);
    expect(runNo(correction.newInvoiceNo)).toBeGreaterThan(runNo(original.number));

    const row = await db.invoiceCorrection.findUniqueOrThrow({ where: { id: correction.id } });
    expect(row).toMatchObject({
      orderId: order.id,
      originalInvoiceNo: original.number,
      newInvoiceNo: correction.newInvoiceNo,
      sac: original.sac,
      taxablePaise: originalBilling.taxablePaise,
      cgstPaise: originalBilling.cgstPaise,
      sgstPaise: originalBilling.sgstPaise,
      igstPaise: originalBilling.igstPaise,
      totalPaise: originalBilling.totalPaise,
      changedFields: ["address", "gstin"],
      reason: REASON,
      createdById: callers.FINANCE.user.id,
    });
    expect(row.originalIssuedAt.toISOString()).toBe(original.issuedAt.toISOString());
    expect(row.originalSeller).toEqual(original.seller);
    expect((row.originalBilling as { gstin: string | null }).gstin).toBeNull();

    const invoice = await db.invoice.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(invoice.number).toBe(correction.newInvoiceNo);
    const after = await snapshot(order);
    expect(after).toEqual(before);
    const billing = (await db.order.findUniqueOrThrow({ where: { id: order.id } })).billing as { gstin: string; address: string; state: string; email: string };
    expect([billing.gstin, billing.address, billing.state, billing.email]).toEqual([MH_GSTIN, "Unit 7, FC Road", "Maharashtra", order.email]);
    const audits = await db.auditLog.findMany({ where: { targetType: "order", targetId: order.id, action: "Corrected billing details" } });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.detail).toBe(`Changed: address, gstin · Credit note ${correction.creditNoteNo} cancels ${original.number} · New invoice ${correction.newInvoiceNo}`);

    // A refund afterwards is still possible; its credit note is the next number of the same series.
    const refund = await issueOrderRefund({
      orderId: order.id,
      staff: { id: finance.id, role: "FINANCE" },
      actor: actorFromStaff(finance),
      body: { reason: "Customer changed their mind", confirmId: order.id },
      provider: getPaymentProvider("mock"),
    });
    const refundNo = refund.refund.creditNoteNo ?? "";
    expect(fyOf(refundNo)).toBe(fyOf(correction.creditNoteNo));
    expect(runNo(refundNo)).toBe(runNo(correction.creditNoteNo) + 1);
  });

  it("refuses a state change, an email change, a GSTIN from another state and a no-op", async () => {
    const order = await paid();
    const cases: [Record<string, string>, string][] = [
      [{ state: "Karnataka" }, "billing.state"],
      [{ email: "someone-else@example.test" }, "billing.email"],
      [{ gstin: "29ABCDE1234F1Z5" }, "billing.gstin"],
    ];
    for (const [billing, field] of cases) {
      const e = await apiError(correctOrderBilling(order.id, billingCorrectionBody.parse({ billing, reason: REASON }), ctx()));
      expect(e.status, field).toBe(422);
      expect(Object.keys((e.details as { fieldErrors: object }).fieldErrors), field).toContain(field);
    }
    const gstin = await apiError(correctOrderBilling(order.id, billingCorrectionBody.parse({ billing: { gstin: "29ABCDE1234F1Z5" }, reason: REASON }), ctx()));
    expect((gstin.details as { fieldErrors: Record<string, string[]> }).fieldErrors["billing.gstin"]?.[0]).toMatch(/registered in Karnataka.*The billing state can’t change on a paid order\.$/);
    const noop = await apiError(correctOrderBilling(order.id, billingCorrectionBody.parse({ billing: { name: "Priya Sharma" }, reason: REASON }), ctx()));
    expect([noop.status, noop.code]).toEqual([422, "nothing_changed"]);
    const reason = await apiError(correctOrderBilling(order.id, billingCorrectionBody.parse({ billing: { gstin: MH_GSTIN } }), ctx()));
    expect(reason.code).toBe("reason_required");
    expect(await db.invoiceCorrection.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("refuses when the seller's state in Settings differs from the original invoice's", async () => {
    const order = await paid();
    const stored = await db.siteSetting.findUnique({ where: { key: "business" } });
    const business = (await getSettings(db)).business;
    await db.siteSetting.upsert({
      where: { key: "business" },
      update: { value: { ...business, state: "Karnataka", gstin: "29AAAAA0000A1Z5" } },
      create: { key: "business", value: { ...business, state: "Karnataka", gstin: "29AAAAA0000A1Z5" } },
    });
    try {
      const e = await apiError(correctOrderBilling(order.id, billingCorrectionBody.parse({ billing: { gstin: MH_GSTIN }, reason: REASON }), ctx()));
      expect([e.status, e.code]).toEqual([409, "seller_state_changed"]);
    } finally {
      if (stored) await db.siteSetting.update({ where: { key: "business" }, data: { value: stored.value as never } });
      else await db.siteSetting.delete({ where: { key: "business" } });
    }
  });

  it("refuses when the business GSTIN in Settings differs from the original invoice's, even in the same state (review fix)", async () => {
    const order = await paid();
    const stored = await db.siteSetting.findUnique({ where: { key: "business" } });
    const business = (await getSettings(db)).business;
    // Same state code (so the same state and GST split), another registration.
    const code = business.gstin.slice(0, 2);
    const reRegistered = business.gstin === `${code}PQRST6789K1Z2` ? `${code}PQRST6789K2Z1` : `${code}PQRST6789K1Z2`;
    await db.siteSetting.upsert({
      where: { key: "business" },
      update: { value: { ...business, gstin: reRegistered } },
      create: { key: "business", value: { ...business, gstin: reRegistered } },
    });
    try {
      expect((await getSettings(db)).business.gstin).toBe(reRegistered);
      const e = await apiError(correctOrderBilling(order.id, billingCorrectionBody.parse({ billing: { gstin: MH_GSTIN }, reason: REASON }), ctx()));
      expect([e.status, e.code]).toEqual([409, "seller_state_changed"]);
      expect(e.message).toContain("state or GSTIN");
      expect(await db.invoiceCorrection.count({ where: { orderId: order.id } })).toBe(0);
    } finally {
      if (stored) await db.siteSetting.update({ where: { key: "business" }, data: { value: stored.value as never } });
      else await db.siteSetting.delete({ where: { key: "business" } });
    }
  });

  it("refuses refunded, partly refunded, refund-pending, in-review and unpaid orders", async () => {
    const body = billingCorrectionBody.parse({ billing: { gstin: MH_GSTIN }, reason: REASON });
    const refundOf = async (order: PaidOrder, amountPaise?: number) =>
      issueOrderRefund({
        orderId: order.id,
        staff: { id: finance.id, role: "FINANCE" },
        actor: actorFromStaff(finance),
        body: { reason: "Refund for the test", confirmId: order.id, amountPaise: amountPaise ?? null },
        provider: getPaymentProvider("mock"),
      });
    const pending = await paid();
    await refundOf(pending);
    const partly = await paid();
    const partial = await refundOf(partly, 1000);
    await processRefund(partly, partial.providerRefundId, 1000);
    const full = await paid();
    const whole = await refundOf(full);
    await processRefund(full, whole.providerRefundId, full.totalPaise);
    const review = await paid();
    await db.order.update({ where: { id: review.id }, data: { status: "REVIEW" } });
    const unpaid = await placeOrder({ accountId: account.accountId, items: [{ plan: cat.plans.annual }] });
    for (const id of [pending.id, partly.id, full.id, review.id, unpaid.id]) {
      const e = await apiError(correctOrderBilling(id, body, ctx()));
      expect([e.status, e.code], id).toEqual([409, "not_correctable"]);
    }
    expect((await db.order.findUniqueOrThrow({ where: { id: partly.id } })).status).toBe("PARTIALLY_REFUNDED");
    expect((await db.order.findUniqueOrThrow({ where: { id: full.id } })).status).toBe("REFUNDED");
  });

  it("chains: a second correction cancels the invoice the first one issued", async () => {
    const order = await paid();
    const first = await correctOrderBilling(order.id, billingCorrectionBody.parse({ billing: { gstin: MH_GSTIN }, reason: REASON }), ctx());
    const second = await correctOrderBilling(order.id, billingCorrectionBody.parse({ billing: { city: "Pimpri" }, reason: REASON }), ctx());
    expect(second.correction.originalInvoiceNo).toBe(first.correction.newInvoiceNo);
    expect((await db.invoice.findUniqueOrThrow({ where: { orderId: order.id } })).number).toBe(second.correction.newInvoiceNo);
    expect(second.order.corrections.map((c) => c.creditNoteNo)).toEqual([first.correction.creditNoteNo, second.correction.creditNoteNo]);
  });
});

describe("credit note and invoice documents", () => {
  it("serve the credit note to staff and the customer, and print the replacement note on the invoice", async () => {
    const order = await paid();
    const { correction } = await correctOrderBilling(order.id, billingCorrectionBody.parse({ billing: { gstin: MH_GSTIN }, reason: REASON }), ctx());
    const adminPdf = await callRoute(jar, adminNoteRoute.GET, {
      path: `/api/admin/orders/${order.id}/credit-notes/${correction.id}`,
      params: { id: order.id, noteId: correction.id },
      session: callers.SUPPORT,
    });
    expect(adminPdf.status).toBe(200);
    expect(adminPdf.headers.get("content-type")).toBe("application/pdf");
    expect(adminPdf.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await adminPdf.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");

    const token = signOrderToken(order.id, order.email);
    const customerPdf = await callRoute(jar, customerNoteRoute.GET, {
      path: `/api/orders/${order.id}/credit-notes/${correction.id}?t=${encodeURIComponent(token)}`,
      params: { id: order.id, noteId: correction.id },
      session: null,
    });
    expect(customerPdf.status).toBe(200);
    expect(customerPdf.headers.get("content-disposition")).toMatch(/^attachment; filename="CreditNote-[A-Z0-9-]+\.pdf"$/);

    // Another account's member cannot see it; a note of another order is 404 even with this order's link.
    const other = await makeOrdersAccount();
    const otherMember = await startSession(await db.user.findUniqueOrThrow({ where: { id: other.ownerId } }), { activeAccountId: other.accountId });
    const foreign = await callRoute(jar, customerNoteRoute.GET, {
      path: `/api/orders/${order.id}/credit-notes/${correction.id}`,
      params: { id: order.id, noteId: correction.id },
      session: otherMember,
    });
    expect(foreign.status).toBe(404);
    const otherOrder = await paid();
    const otherNote = await correctOrderBilling(otherOrder.id, billingCorrectionBody.parse({ billing: { gstin: MH_GSTIN }, reason: REASON }), ctx());
    const mismatch = await callRoute(jar, customerNoteRoute.GET, {
      path: `/api/orders/${order.id}/credit-notes/${otherNote.correction.id}?t=${encodeURIComponent(token)}`,
      params: { id: order.id, noteId: otherNote.correction.id },
      session: null,
    });
    expect(mismatch.status).toBe(404);
    const adminMismatch = await callRoute(jar, adminNoteRoute.GET, {
      path: `/api/admin/orders/${order.id}/credit-notes/${otherNote.correction.id}`,
      params: { id: order.id, noteId: otherNote.correction.id },
      session: callers.FINANCE,
    });
    expect(adminMismatch.status).toBe(404);

    const model = await loadInvoiceModel(db, order.id);
    expect(model?.number).toBe(correction.newInvoiceNo);
    expect(model?.extraNotes).toEqual([
      `This invoice replaces ${correction.originalInvoiceNo}, cancelled by credit note ${correction.creditNoteNo} (billing details corrected).`,
    ]);
  });
});

describe("reports", () => {
  it("count the cancelled original in its month and net the correction month to zero", async () => {
    // Far-future dates keep this window to this test's documents.
    const paidAt = new Date("2035-01-15T06:30:00.000Z");
    const correctedAt = new Date("2035-02-10T06:30:00.000Z");
    const order = await paid(paidAt);
    const { correction } = await correctOrderBilling(order.id, billingCorrectionBody.parse({ billing: { gstin: MH_GSTIN }, reason: REASON }), ctx(correctedAt));
    const win = { from: new Date("2034-12-31T18:30:00.000Z"), to: new Date("2035-02-28T18:30:00.000Z") };

    const months = await invoicesByMonth(db, win);
    const jan = months.find((m) => m.key === "2035-01");
    const feb = months.find((m) => m.key === "2035-02");
    expect(jan?.count).toBe(1);
    expect(feb?.count).toBe(1);
    expect(jan?.taxablePaise).toBe(feb?.taxablePaise);

    const notes = await creditNotesInWindow(db, win);
    const note = notes.find((n) => n.number === correction.creditNoteNo);
    expect(note).toMatchObject({ kind: "correction", status: "PROCESSED", amountPaise: order.totalPaise });
    expect(note?.order.invoiceNumber).toBe(correction.originalInvoiceNo);

    const { gstByMonth } = monthlyRows(["2035-01", "2035-02"], months, notes);
    const febInvoices = gstByMonth.invoices.find((r) => r.key === "2035-02");
    const febCredits = gstByMonth.creditNotes.find((r) => r.key === "2035-02");
    expect(febInvoices?.taxPaise).toBe(febCredits?.taxPaise);
    expect((febInvoices?.taxablePaise ?? 0) - (febCredits?.taxablePaise ?? 0)).toBe(0);

    const register = await buildReportExport(db, "sales-register", { range: "12m", now: new Date("2035-03-01T06:30:00.000Z") });
    const cancelled = register.rows.find((r) => r[0] === correction.originalInvoiceNo);
    const current = register.rows.find((r) => r[0] === correction.newInvoiceNo);
    expect(cancelled?.at(-1)).toBe(`Cancelled by ${correction.creditNoteNo}`);
    expect(current?.at(-1)).toBe(`Replaces ${correction.originalInvoiceNo}`);
    const refunds = await buildReportExport(db, "refunds", { range: "12m", now: new Date("2035-03-01T06:30:00.000Z") });
    expect(refunds.rows.find((r) => r[0] === correction.creditNoteNo)?.[4]).toBe("Billing correction");
  });
});
