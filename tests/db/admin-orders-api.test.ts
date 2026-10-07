/**
 * Admin orders API (decisions.md Phase 6): list filters/search/sort/paging, stats, the drawer detail, CSV export
 * (reports.export, audited), resend invoice (all staff, audited, double-click safe) and webhook replay
 * (payments.replay, idempotent, audited). Rows are scoped to this file's own product and business names, because
 * the test schema is shared with every other DB test file of the run.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GET as listRoute } from "@/app/api/admin/orders/route";
import { GET as exportRoute } from "@/app/api/admin/orders/export.csv/route";
import { POST as bulkResendRoute } from "@/app/api/admin/orders/resend-invoices/route";
import { GET as detailRoute } from "@/app/api/admin/orders/[id]/route";
import { POST as resendRoute } from "@/app/api/admin/orders/[id]/resend-invoice/route";
import { POST as replayRoute } from "@/app/api/admin/webhooks/[id]/replay/route";
import { adminOrderFilterOptions, adminOrderStats } from "@/lib/admin/orders/list";
import type { AdminOrderDetail, AdminOrderList } from "@/lib/admin/orders/model";
import { db } from "@/lib/db";
import { callRoute, errorCodeOf, makeAdminCallers, type AdminCallers, type TestSession } from "../support/admin-fixtures";
import {
  fxTag,
  makeOrdersAccount,
  makeOrdersCatalog,
  paidOrder,
  placeOrder,
  type OrdersCatalog,
  type PaidOrder,
  type PlacedOrder,
} from "./admin-orders-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

let callers: AdminCallers;
let catalog: OrdersCatalog;
let paid: PaidOrder;
let paidCoupon: PaidOrder;
let unpaid: PlacedOrder;
const business = `Zephyr Traders ${fxTag}`;

beforeAll(async () => {
  callers = await makeAdminCallers();
  catalog = await makeOrdersCatalog();
  const account = await makeOrdersAccount();
  paid = await paidOrder({ accountId: account.accountId, items: [{ plan: catalog.plans.oneTime }], business });
  await db.order.update({ where: { id: paid.id }, data: { billing: { name: "Priya Sharma", business, email: paid.email, phone: "9820000000", address: "Shop 4", city: "Pune", state: "Maharashtra", pin: "411004", gstin: "27ABCDE1234F1Z5" } } });
  await db.coupon.upsert({ where: { code: `AO${fxTag.toUpperCase()}` }, create: { code: `AO${fxTag.toUpperCase()}`, type: "PERCENT", value: 10, label: "10% off", productIds: [], planTypes: [], startsAt: new Date(Date.now() - 86_400_000), endsAt: new Date(Date.now() + 86_400_000) }, update: {} });
  paidCoupon = await paidOrder({ items: [{ plan: catalog.plans.annual }], couponCode: `AO${fxTag.toUpperCase()}` });
  unpaid = await placeOrder({ items: [{ plan: catalog.plans.annual, quantity: 2 }] });
});

const get = (handler: unknown, path: string, session: TestSession | null, params: Record<string, string> = {}) =>
  callRoute(jar, handler, { path, params, session });
const post = (handler: unknown, path: string, session: TestSession | null, params: Record<string, string>, body?: unknown) =>
  callRoute(jar, handler, { method: "POST", path, params, session, body });

async function list(query: string, session: TestSession = callers.SUPPORT): Promise<AdminOrderList> {
  const res = await get(listRoute, `/api/admin/orders?${query}`, session);
  expect(res.status, (await errorCodeOf(res)) ?? "").toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as AdminOrderList;
}


const byProduct = () => `filter[product]=${encodeURIComponent(catalog.product.id)}`;

describe("GET /api/admin/orders", () => {
  it("lists this product's orders newest first with the table fields", async () => {
    const page = await list(byProduct());
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(page.items.map((o) => o.id)).toEqual([unpaid.id, paidCoupon.id, paid.id]);
    const row = page.items.find((o) => o.id === paid.id);
    expect(row).toMatchObject({
      customer: business,
      email: paid.email,
      status: "paid",
      method: "UPI",
      provider: "mock",
      totalPaise: paid.totalPaise,
      taxLabel: "CGST+SGST",
      items: `${catalog.product.shortName} \u00B7 One-time license`,
    });
    expect(row?.invoiceNumber).toMatch(/^AXS\/\d{2}-\d{2}\/\d{4,}$/);
    expect(page.items.find((o) => o.id === unpaid.id)?.items).toBe(`${catalog.product.shortName} \u00B7 Annual license \u00D72`);
  });

  it("labels products by short name, also in the Product filter (catalog rank order)", async () => {
    const options = await adminOrderFilterOptions(db);
    expect(options.products.find((p) => p.value === catalog.product.id)?.label).toBe("Refund");
    const ranks = await db.product.findMany({ where: { id: { in: options.products.map((p) => p.value) } }, select: { id: true, rank: true } });
    const rankOf = new Map(ranks.map((r) => [r.id, r.rank]));
    const ordered = options.products.map((p) => rankOf.get(p.value) ?? 0);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
  });

  it("filters by status, coupon, method, provider and date, sorts and pages", async () => {
    expect((await list(`${byProduct()}&filter[status]=paid`)).items.map((o) => o.id).sort()).toEqual([paid.id, paidCoupon.id].sort());
    expect((await list(`${byProduct()}&filter[status]=confirming`)).items.map((o) => o.id)).toEqual([unpaid.id]);
    expect((await list(`${byProduct()}&filter[coupon]=any`)).items.map((o) => o.id)).toEqual([paidCoupon.id]);
    expect((await list(`${byProduct()}&filter[coupon]=AO${fxTag.toUpperCase()}`)).total).toBe(1);
    expect((await list(`${byProduct()}&filter[coupon]=none`)).total).toBe(2);
    expect((await list(`${byProduct()}&filter[method]=upi`)).total).toBe(2);
    expect((await list(`${byProduct()}&filter[method]=card`)).total).toBe(0);
    expect((await list(`${byProduct()}&filter[provider]=mock`)).total).toBe(3);
    expect((await list(`${byProduct()}&filter[date]=today`)).total).toBe(3);
    expect((await list(`${byProduct()}&filter[from]=2020-01-01&filter[to]=2020-12-31`)).total).toBe(0);
    const byTotal = await list(`${byProduct()}&sort=-totalPaise`);
    expect(byTotal.items[0]?.id).toBe(paid.id);
    const paged = await list(`${byProduct()}&pageSize=2&page=2`);
    expect(paged).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(paged.items).toHaveLength(1);
    // Lenient parsing: unknown values fall back to the defaults.
    expect((await list(`${byProduct()}&filter[status]=bogus&sort=nope&pageSize=500`)).pageSize).toBe(100);
  });

  it("searches order id, business, email, GSTIN, invoice and payment id", async () => {
    const invoice = (await db.invoice.findUniqueOrThrow({ where: { orderId: paid.id } })).number;
    for (const q of [paid.id, paid.id.toLowerCase(), `zephyr traders ${fxTag}`, paid.email.toUpperCase(), "27ABCDE1234F1Z5", invoice, paid.providerPaymentId, paid.providerOrderId]) {
      const ids = (await list(`q=${encodeURIComponent(q)}`)).items.map((o) => o.id);
      expect(ids, q).toContain(paid.id);
    }
    expect((await list(`q=${encodeURIComponent(`nothing-like-this-${fxTag}`)}`)).total).toBe(0);
  });

  it("needs a staff session", async () => {
    expect((await get(listRoute, "/api/admin/orders", null)).status).toBe(401);
    expect((await get(listRoute, "/api/admin/orders", callers.customer)).status).toBe(403);
  });
});

describe("stats", () => {
  it("counts paid, in-flight and failed orders and the money refunded", async () => {
    const before = await adminOrderStats(db);
    const failed = await placeOrder({ items: [{ plan: catalog.plans.annual }] });
    await db.order.update({ where: { id: failed.id }, data: { status: "FAILED" } });
    const after = await adminOrderStats(db);
    expect(after.failed).toBe(before.failed + 1);
    expect(after.paid).toBeGreaterThanOrEqual(2);
    expect(after.pending).toBeGreaterThanOrEqual(1);
    await db.order.update({ where: { id: failed.id }, data: { status: "CANCELED" } });
  });
});

describe("GET /api/admin/orders/:id", () => {
  it("returns the drawer: totals, items, payments, webhook events, masked licenses, history and refund state", async () => {
    const res = await get(detailRoute, `/api/admin/orders/${paid.id}`, callers.SUPPORT, { id: paid.id });
    expect(res.status).toBe(200);
    const { order } = (await res.json()) as { order: AdminOrderDetail };
    expect(order).toMatchObject({ id: paid.id, status: "paid", customer: business, gstin: "27ABCDE1234F1Z5", placeOfSupply: "Maharashtra", totalPaise: paid.totalPaise });
    expect(order.cgstPaise + order.sgstPaise).toBe(paid.totalPaise - order.taxablePaise);
    expect(order.invoice?.number).toMatch(/^AXS\//);
    expect(order.items).toHaveLength(1);
    expect(order.items[0]).toMatchObject({ product: catalog.product.shortName, kind: "NEW", quantity: 1, issuedLicenseId: paid.licenseIds[0], fulfilled: true, linePaise: catalog.plans.oneTime.pricePaise });
    expect(order.payments[0]).toMatchObject({ status: "captured", method: "UPI", providerPaymentId: paid.providerPaymentId });
    expect(order.webhooks).toEqual([expect.objectContaining({ eventId: paid.eventId, type: "payment.captured", result: "fulfilled", replayable: true })]);
    expect(order.licenses).toEqual([expect.objectContaining({ id: paid.licenseIds[0], product: catalog.product.shortName, status: "active" })]);
    expect(order.licenses[0]?.maskedKey).toMatch(new RegExp(`^${catalog.product.code}-\u2022{4}-\u2022{4}-\u2022{4}-[A-Z2-9]{4}$`));
    expect(JSON.stringify(order)).not.toMatch(/keyCiphertext|keyHash/);
    expect(order.history.map((h) => h.action)).toContain("Webhook processed");
    expect(order.refund).toEqual({ allowed: true, amountPaise: paid.totalPaise, licenseCount: 1, changeCount: 0 });
  });

  it("refund is not allowed for an unpaid order; unknown ids are 404", async () => {
    const res = await get(detailRoute, `/api/admin/orders/${unpaid.id}`, callers.FINANCE, { id: unpaid.id });
    const { order } = (await res.json()) as { order: AdminOrderDetail };
    expect(order.refund.allowed).toBe(false);
    expect(order.invoice).toBeNull();
    expect((await get(detailRoute, "/api/admin/orders/AX-0000002", callers.FINANCE, { id: "AX-0000002" })).status).toBe(404);
  });
});

describe("GET /api/admin/orders/export.csv", () => {
  it("exports for Owner / Finance (audited) and refuses Admin / Support", async () => {
    for (const session of [callers.ADMIN, callers.SUPPORT]) {
      expect((await get(exportRoute, `/api/admin/orders/export.csv?${byProduct()}`, session)).status).toBe(403);
    }
    const res = await get(exportRoute, `/api/admin/orders/export.csv?${byProduct()}&filter[status]=paid`, callers.FINANCE);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("x-row-count")).toBe("2");
    const csv = await res.text();
    expect(csv.split("\r\n")[0]).toContain("Order");
    expect(csv).toContain(paid.id);
    expect(csv).toContain(paidCoupon.id);
    expect(csv).not.toContain(unpaid.id);
    const audit = await db.auditLog.findFirst({ where: { action: "Exported report", actorId: callers.FINANCE.user.id }, orderBy: { createdAt: "desc" } });
    expect(audit?.detail).toContain("status: paid");
  });

  it("exports only the selected ids as orders-selected.csv", async () => {
    const res = await get(exportRoute, `/api/admin/orders/export.csv?ids=${paid.id},${unpaid.id}`, callers.OWNER);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("orders-selected.csv");
    expect(res.headers.get("x-row-count")).toBe("2");
  });
});

describe("resend invoice", () => {
  it("queues the invoice email for any staff role, once per click, and audits it", async () => {
    const path = `/api/admin/orders/${paidCoupon.id}/resend-invoice`;
    const res = await post(resendRoute, path, callers.SUPPORT, { id: paidCoupon.id }, {});
    expect(res.status).toBe(202);
    const emails = await db.outboxEmail.findMany({ where: { dedupeKey: { startsWith: `order_confirmation:${paidCoupon.id}:resend:` } } });
    expect(emails).toHaveLength(1);
    expect(emails[0]?.to).toBe(paidCoupon.email);
    const again = await post(resendRoute, path, callers.SUPPORT, { id: paidCoupon.id });
    expect(again.status).toBe(409);
    expect(await errorCodeOf(again)).toBe("already_queued");
    expect(await db.auditLog.count({ where: { action: "Resent invoice", targetId: paidCoupon.id } })).toBe(1);
  });

  it("refuses orders without an invoice and unknown orders", async () => {
    const res = await post(resendRoute, `/api/admin/orders/${unpaid.id}/resend-invoice`, callers.FINANCE, { id: unpaid.id }, {});
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe("invoice_unavailable");
    expect((await post(resendRoute, "/api/admin/orders/AX-0000003/resend-invoice", callers.FINANCE, { id: "AX-0000003" }, {})).status).toBe(404);
  });

  it("bulk: queues invoiced orders and reports the skipped ones", async () => {
    const res = await post(bulkResendRoute, "/api/admin/orders/resend-invoices", callers.ADMIN, {}, { ids: [paid.id, unpaid.id, "AX-0000004"] });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { queued: string[]; skipped: { id: string; reason: string }[] };
    expect(body.queued).toEqual([paid.id]);
    expect(body.skipped.map((s) => s.id)).toEqual([unpaid.id, "AX-0000004"]);
    expect((await post(bulkResendRoute, "/api/admin/orders/resend-invoices", callers.ADMIN, {}, { ids: [] })).status).toBe(422);
  });
});

describe("POST /api/admin/webhooks/:eventId/replay", () => {
  it("re-runs the stored event idempotently for Owner / Admin / Finance and audits it", async () => {
    const path = `/api/admin/webhooks/${paid.eventId}/replay`;
    expect((await post(replayRoute, path, callers.SUPPORT, { id: paid.eventId }, {})).status).toBe(403);
    const licensesBefore = await db.license.count({ where: { orderId: paid.id } });
    const res = await post(replayRoute, path, callers.ADMIN, { id: paid.eventId }, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eventId: paid.eventId, provider: "mock", result: "duplicate_ignored" });
    const delivery = await db.webhookDelivery.findFirst({ where: { eventId: paid.eventId, replayedById: callers.ADMIN.user.id } });
    expect(delivery?.result).toBe("duplicate_ignored");
    expect(await db.license.count({ where: { orderId: paid.id } })).toBe(licensesBefore);
    expect((await db.order.findUniqueOrThrow({ where: { id: paid.id } })).status).toBe("PAID");
    const audit = await db.auditLog.findFirst({ where: { action: "Replayed webhook", targetId: paid.eventId } });
    expect(audit).toMatchObject({ actorId: callers.ADMIN.user.id, targetType: "webhook", detail: `Idempotency check: duplicate ignored \u00B7 order ${paid.id}` });

    // The drawer shows the replay with who ran it.
    const detail = await get(detailRoute, `/api/admin/orders/${paid.id}`, callers.FINANCE, { id: paid.id });
    const { order } = (await detail.json()) as { order: AdminOrderDetail };
    expect(order.webhooks.map((w) => w.result)).toEqual(["fulfilled", "duplicate_ignored"]);
    expect(order.webhooks[1]?.replayedBy).toBe(callers.ADMIN.user.name);
  });

  it("answers 404 for an unknown event", async () => {
    const res = await post(replayRoute, "/api/admin/webhooks/evt_unknown_000/replay", callers.OWNER, { id: "evt_unknown_000" }, {});
    expect(res.status).toBe(404);
  });
});
