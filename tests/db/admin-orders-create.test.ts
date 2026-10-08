/**
 * Admin records PART B (docs/admin-records-design.md B12.1, database): the "New order" quote prices exactly like
 * checkout; a payment-link order is unpaid, has no payment attempt and is licensed only by the verified webhook after
 * the customer accepts the terms; an offline payment creates and fulfils the order in one transaction through the
 * webhook's own code, exactly once (double submits replay), and refuses wrong amounts, dates and references without
 * storing anything; every new route answers per role.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type * as QuoteModule from "@/lib/checkout/quote";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));
/** Runs once right after the next priceCart(): "the target license was revoked between the quote and the submit". */
const hooks = vi.hoisted(() => ({ afterPrice: null as null | (() => Promise<void>) }));
vi.mock("@/lib/checkout/quote", async (importOriginal) => {
  const orig = await importOriginal<typeof QuoteModule>();
  return {
    ...orig,
    priceCart: async (...args: Parameters<typeof orig.priceCart>) => {
      const priced = await orig.priceCart(...args);
      const hook = hooks.afterPrice;
      hooks.afterPrice = null;
      if (hook) await hook();
      return priced;
    },
  };
});

import type { User } from "@/generated/prisma/client";
import * as offlineRoute from "@/app/api/admin/orders/offline/route";
import * as quoteRoute from "@/app/api/admin/orders/quote/route";
import * as createRoute from "@/app/api/admin/orders/route";
import { createPaymentLinkOrder } from "@/lib/admin/orders/create";
import { createOfflinePaidOrder } from "@/lib/admin/orders/offline";
import { istToday } from "@/lib/admin/orders/records-model";
import { offlineOrderBody, orderCreateBody } from "@/lib/admin/orders/schemas";
import { actorFromStaff } from "@/lib/audit";
import { CHECKOUT_TERMS_VERSION } from "@/lib/checkout/create-order";
import { retryPayment } from "@/lib/checkout/payment-attempt";
import { priceCart, toQuoteDto, type QuoteDto } from "@/lib/checkout/quote";
import { startOfDayIST } from "@/lib/dates";
import { db } from "@/lib/db";
import { getLicenseKeySecrets } from "@/lib/env";
import { ApiError } from "@/lib/http";
import { decryptLicenseKey } from "@/lib/licensing/crypto";
import { resolveOrderAccessFor } from "@/lib/orders/access";
import { buildOrderStatus } from "@/lib/orders/status";
import { inspectOrderToken } from "@/lib/orders/token";
import { getPaymentProvider } from "@/lib/payments";
import { mockCapture } from "@/lib/payments/mock";
import { processPaymentEvent } from "@/lib/payments/webhook";
import { callRoute, errorCodeOf, makeAdminCallers, makeStaff, type AdminCallers, type TestSession } from "../support/admin-fixtures";
import {
  adminOrderBilling,
  fxTag,
  issueTestLicense,
  makeAdminOrderInput,
  makeOrdersAccount,
  makeOrdersCatalog,
  type OrdersCatalog,
  type TestAccount,
} from "./admin-orders-fixtures";
import { makeCoupon } from "./checkout-fixtures";

const REASON = "Phone order from the owner";
let callers: AdminCallers;
let cat: OrdersCatalog;
let account: TestAccount;
let finance: User;
let owner: User;

beforeAll(async () => {
  callers = await makeAdminCallers();
  cat = await makeOrdersCatalog();
  account = await makeOrdersAccount();
  finance = await makeStaff("FINANCE");
  owner = await makeStaff("OWNER");
});

type Json = Record<string, unknown> & { error?: { code: string; message: string; fieldErrors?: Record<string, string[]> } & Record<string, unknown> };
const body = async (res: Response) => (await res.json()) as Json;
const post = (handler: unknown, path: string, session: TestSession | null, payload: unknown) =>
  callRoute(jar, handler, { method: "POST", path, session, body: payload });
const ctxOf = (staff: User) => ({ staff: { id: staff.id, role: staff.staffRole ?? "FINANCE" }, actor: actorFromStaff(staff) });
const input = (over: Record<string, unknown> = {}) => orderCreateBody.parse(makeAdminOrderInput(account, cat.plans, over));

/** What the order costs: checkout's own pricing for the account's owner. */
async function totalOf(items: unknown[], couponCode: string | null = null, state = "Maharashtra"): Promise<number> {
  const parsed = orderCreateBody.parse(makeAdminOrderInput(account, cat.plans, { items, couponCode }));
  const priced = await priceCart(db, { items: parsed.items, couponCode: parsed.couponCode, billingState: state }, { kind: "customer", membership: { accountId: account.accountId, role: "OWNER" } }, new Date());
  return priced.quote.totalPaise;
}

const offlineInput = async (over: Record<string, unknown> = {}) => {
  const items = (over.items as unknown[] | undefined) ?? [{ planId: cat.plans.annual.id, qty: 1 }];
  const amountPaise = (over.amountPaise as number | undefined) ?? (await totalOf(items, (over.couponCode as string | null | undefined) ?? null));
  return offlineOrderBody.parse(
    makeAdminOrderInput(account, cat.plans, { method: "cash", receivedOn: istToday(new Date()), ...over, items, amountPaise }),
  );
};

async function apiError(promise: Promise<unknown>): Promise<ApiError> {
  const e = await promise.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
}

const invoiceCounter = async () => {
  const rows = await db.counter.findMany({ where: { key: { startsWith: "invoice:" } } });
  return rows.map((r) => `${r.key}=${r.next}`).sort().join(",");
};

describe("roles (every new create route)", () => {
  it("quote and create: Owner and Finance only; offline payments: Owner and Finance only", async () => {
    const quoteBody = { accountId: account.accountId, items: [{ planId: cat.plans.annual.id, qty: 1 }] };
    for (const role of ["OWNER", "FINANCE"] as const) {
      expect((await post(quoteRoute.POST, "/api/admin/orders/quote", callers[role], quoteBody)).status, role).toBe(200);
    }
    for (const session of [callers.ADMIN, callers.SUPPORT, callers.customer]) {
      for (const [handler, path, payload] of [
        [quoteRoute.POST, "/api/admin/orders/quote", quoteBody],
        [createRoute.POST, "/api/admin/orders", makeAdminOrderInput(account, cat.plans)],
        [offlineRoute.POST, "/api/admin/orders/offline", makeAdminOrderInput(account, cat.plans, { method: "cash", receivedOn: istToday(new Date()), amountPaise: 1 })],
      ] as const) {
        const res = await post(handler, path, session, payload);
        expect(res.status, path).toBe(403);
        expect(await errorCodeOf(res)).toBe("forbidden");
      }
    }
    expect((await post(createRoute.POST, "/api/admin/orders", null, makeAdminOrderInput(account, cat.plans))).status).toBe(401);
    const noCsrf = await callRoute(jar, createRoute.POST, { method: "POST", path: "/api/admin/orders", session: callers.OWNER, body: makeAdminOrderInput(account, cat.plans), csrf: false });
    expect(await errorCodeOf(noCsrf)).toBe("csrf_failed");
  });

  it("checks the reason before anything else (422 reason_required, nothing stored)", async () => {
    const requestId = randomUUID();
    const res = await post(createRoute.POST, "/api/admin/orders", callers.FINANCE, makeAdminOrderInput(account, cat.plans, { requestId, reason: "no" }));
    expect(res.status).toBe(422);
    expect(await errorCodeOf(res)).toBe("reason_required");
    expect(await db.order.count({ where: { staffRequestId: requestId } })).toBe(0);
  });
});

describe("quote parity with checkout", () => {
  it("prices exactly like POST /api/checkout/quote, intra-state and inter-state, with a coupon", async () => {
    const coupon = await makeCoupon({ type: "PERCENT", value: 10 });
    const items = [
      { planId: cat.plans.annual.id, qty: 1 },
      { planId: cat.plans.oneTime.id, qty: 1 },
    ];
    for (const state of ["Maharashtra", "Karnataka"]) {
      const res = await post(quoteRoute.POST, "/api/admin/orders/quote", callers.FINANCE, { accountId: account.accountId, items, couponCode: coupon, billingState: state });
      expect(res.status).toBe(200);
      const { quote } = (await res.json()) as { quote: QuoteDto };
      // The checkout quote route's own code path: priceCart for the buyer, then toQuoteDto.
      const checkout = toQuoteDto(await priceCart(db, { items, couponCode: coupon, billingState: state }, { kind: "guest" }, new Date()));
      expect(quote).toEqual(checkout);
      expect(quote.intraState).toBe(state === "Maharashtra");
      expect(quote.coupon).toMatchObject({ ok: true, code: coupon });
    }
  });

  it("needs exactly one of a customer and an order, and 404s unknown ones", async () => {
    const both = await post(quoteRoute.POST, "/api/admin/orders/quote", callers.OWNER, { accountId: account.accountId, orderId: "AX-1", items: [] });
    expect(both.status).toBe(422);
    const unknown = await post(quoteRoute.POST, "/api/admin/orders/quote", callers.OWNER, { accountId: `nope-${fxTag}`, items: [] });
    expect(unknown.status).toBe(404);
  });
});

describe("payment-link orders", () => {
  it("creates an unpaid order with no payment attempt, an outbox email, an audit row and a working order link", async () => {
    const payload = makeAdminOrderInput(account, cat.plans);
    const res = await post(createRoute.POST, "/api/admin/orders", callers.FINANCE, payload);
    expect(res.status).toBe(201);
    const result = await body(res);
    expect(result).toMatchObject({ status: "awaiting_payment", emailQueued: true, replayed: false });
    const orderId = result.orderId as string;
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true, invoice: true } });
    expect(order).toMatchObject({
      status: "AWAITING_PAYMENT",
      accountId: account.accountId,
      placedByUserId: null,
      createdByStaffId: callers.FINANCE.user.id,
      staffRequestId: payload.requestId,
      termsAcceptedAt: null,
      email: account.ownerEmail,
      placeOfSupply: "Maharashtra",
    });
    expect(order.payments).toEqual([]);
    expect(order.invoice).toBeNull();
    expect(order.totalPaise).toBe(result.totalPaise);
    expect(await db.license.count({ where: { orderId } })).toBe(0);
    const mail = await db.outboxEmail.findMany({ where: { templateId: "order_payment_link", dedupeKey: `order_payment_link:${orderId}` } });
    expect(mail).toHaveLength(1);
    expect(mail[0]?.to).toBe(account.ownerEmail);
    const audits = await db.auditLog.findMany({ where: { targetType: "order", targetId: orderId } });
    expect(audits.map((a) => [a.action, a.reason])).toEqual([["Created order", REASON]]);
    expect(audits[0]?.detail).toContain("Payment link");
    const url = new URL(result.paymentUrl as string);
    expect(url.pathname).toBe(`/orders/${orderId}`);
    const inspected = inspectOrderToken(url.searchParams.get("t") ?? "", orderId, new Date(), { email: order.email });
    expect(inspected.ok && inspected.payload.scope).toBe("pay");
    // The emailed link is the same pay-only link staff see.
    expect(mail[0]?.text).toContain(url.searchParams.get("t") ?? "-");
  });

  it("is licensed only by the verified webhook, after the customer accepts the terms", async () => {
    const created = await createPaymentLinkOrder(input(), ctxOf(finance));
    const token = new URL(created.paymentUrl).searchParams.get("t") ?? "";
    const access = () => resolveOrderAccessFor(created.orderId, { auth: null, token });
    const provider = getPaymentProvider("mock");

    const refused = await apiError(retryPayment(db, await access(), { provider }));
    expect([refused.status, refused.code]).toEqual([422, "validation_failed"]);
    expect(await db.payment.count({ where: { orderId: created.orderId } })).toBe(0);

    const start = await retryPayment(db, await access(), { provider, terms: { acceptTerms: true, version: CHECKOUT_TERMS_VERSION } });
    expect(start.orderId).toBe(created.orderId);
    const attempt = await db.payment.findFirstOrThrow({ where: { orderId: created.orderId } });
    expect(attempt).toMatchObject({ status: "CREATED", amountPaise: created.totalPaise, provider: "mock" });
    const accepted = await db.order.findUniqueOrThrow({ where: { id: created.orderId } });
    expect(accepted.termsAcceptedAt).not.toBeNull();
    expect(accepted.termsVersion).toBe(CHECKOUT_TERMS_VERSION);
    expect(await db.license.count({ where: { orderId: created.orderId } })).toBe(0);

    const captured = mockCapture(attempt.providerOrderId, created.totalPaise);
    const event = {
      id: `evt_ao_link_${fxTag}_${created.orderId}`,
      type: "payment.captured" as const,
      providerOrderId: attempt.providerOrderId,
      providerPaymentId: captured.providerPaymentId,
      amountPaise: created.totalPaise,
      currency: "INR",
      method: "UPI",
    };
    expect((await processPaymentEvent("mock", event)).result).toBe("fulfilled");
    expect((await processPaymentEvent("mock", event)).result).toBe("duplicate_ignored");
    const paid = await db.order.findUniqueOrThrow({ where: { id: created.orderId }, include: { invoice: true } });
    expect(paid.status).toBe("PAID");
    expect(paid.invoice?.number).toBeTruthy();
    expect(await db.license.count({ where: { orderId: created.orderId } })).toBe(1);
    // The owner's activity names our team, not the owner (they did not place it).
    const activity = await db.accountActivity.findFirstOrThrow({ where: { accountId: account.accountId, target: created.orderId, action: "Placed order" } });
    expect([activity.actorId, activity.actorName]).toEqual([null, "Axiomatic team"]);

    // Whoever holds the shared (pay-only) link, signed out, never gets the one-time key view (review fix).
    const viaLink = await buildOrderStatus(db, await access());
    expect(viaLink.status).toBe("PAID");
    expect(viaLink.licenses.map((l) => l.key)).toEqual([undefined]);
    const license = await db.license.findFirstOrThrow({ where: { orderId: created.orderId } });
    expect(license.keyDeliveredAt).toBeNull();
    // The customer's order_confirmation link is a full order link signed at payment: it delivers the key once.
    const confirmation = await db.outboxEmail.findFirstOrThrow({ where: { dedupeKey: `order_confirmation:${created.orderId}` } });
    const full = /[?&]t=(o1[.][A-Za-z0-9._-]+)/.exec(confirmation.text)?.[1] ?? "";
    expect(full).not.toBe("");
    const delivered = await buildOrderStatus(db, await resolveOrderAccessFor(created.orderId, { auth: null, token: full }));
    expect(delivered.licenses[0]?.key).toBe(decryptLicenseKey(license.keyCiphertext, getLicenseKeySecrets().encKey));
  });

  it("a replay of a payment-link submit whose order was paid or cancelled since answers 409 not_payable, not a new link", async () => {
    const payload = input();
    const first = await createPaymentLinkOrder(payload, ctxOf(finance));
    for (const data of [{ status: "PAID" as const }, { status: "CANCELED" as const, canceledByStaffAt: new Date() }]) {
      await db.order.update({ where: { id: first.orderId }, data });
      const e = await apiError(createPaymentLinkOrder(payload, ctxOf(finance)));
      expect([e.status, e.code]).toEqual([409, "not_payable"]);
    }
    expect(await db.order.count({ where: { staffRequestId: payload.requestId } })).toBe(1);
  });

  it("replays a repeated request for the same staff member and refuses it for another", async () => {
    const payload = input();
    const first = await createPaymentLinkOrder(payload, ctxOf(finance));
    const again = await createPaymentLinkOrder(payload, ctxOf(finance));
    expect(again).toMatchObject({ orderId: first.orderId, replayed: true });
    expect(await db.order.count({ where: { staffRequestId: payload.requestId } })).toBe(1);
    const e = await apiError(createPaymentLinkOrder(payload, ctxOf(owner)));
    expect([e.status, e.code]).toEqual([409, "duplicate_request"]);
  });

  it("refuses a cart checkout would refuse (422 cart_invalid / zero total), storing nothing", async () => {
    const trial = input({ items: [{ planId: cat.plans.trial.id, qty: 1 }] });
    const e = await apiError(createPaymentLinkOrder(trial, ctxOf(finance)));
    expect([e.status, e.code]).toEqual([422, "cart_invalid"]);
    expect(await db.order.count({ where: { staffRequestId: trial.requestId } })).toBe(0);
    const unknown = await apiError(createPaymentLinkOrder(input({ accountId: `nope-${fxTag}` }), ctxOf(finance)));
    expect(unknown.status).toBe(404);
  });
});

describe("offline payments", () => {
  it("creates, pays and fulfils the order in one transaction through the webhook's own code", async () => {
    const target = await issueTestLicense(account.accountId, cat, cat.plans.annual, new Date());
    const coupon = await makeCoupon({ type: "PERCENT", value: 10 });
    const items = [
      { planId: cat.plans.annual.id, qty: 1 },
      { planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: target.id },
    ];
    const amountPaise = await totalOf(items, coupon);
    const today = istToday(new Date());
    const payload = makeAdminOrderInput(account, cat.plans, {
      items,
      couponCode: coupon,
      method: "upi",
      reference: "UTR 4211 0098",
      receivedOn: today,
      amountPaise,
    });
    const res = await post(offlineRoute.POST, "/api/admin/orders/offline", callers.OWNER, payload);
    expect(res.status).toBe(201);
    const result = await body(res);
    expect(result).toMatchObject({ status: "paid", licensesIssued: 1, licensesUpdated: 1, totalPaise: amountPaise, replayed: false });
    const orderId = result.orderId as string;

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true, invoice: true, items: true } });
    expect(order).toMatchObject({ status: "PAID", createdByStaffId: callers.OWNER.user.id, couponCode: coupon, termsAcceptedAt: null });
    expect(order.payments).toHaveLength(1);
    expect(order.payments[0]).toMatchObject({
      provider: "offline",
      providerOrderId: `offline:${orderId}`,
      providerPaymentId: null,
      status: "CAPTURED",
      method: "UPI",
      amountPaise,
      reference: "UTR 4211 0098",
      recordedById: callers.OWNER.user.id,
    });
    expect(order.payments[0]?.receivedAt?.toISOString()).toBe(startOfDayIST(today).toISOString());
    expect(order.invoice?.number).toBe(result.invoiceNumber);
    expect(order.invoice?.number).toMatch(/^[A-Z0-9-]{1,3}\/\d{2}-\d{2}\/\d{4,}$/);
    const renewal = order.items.find((i) => i.kind === "RENEWAL");
    expect(renewal?.fulfilledAt).not.toBeNull();
    expect(renewal?.termsBefore).not.toBeNull();
    expect(renewal?.termsAfter).not.toBeNull();

    const licenses = await db.license.findMany({ where: { orderId } });
    expect(licenses).toHaveLength(1);
    const lic = licenses[0];
    expect(lic?.keyCiphertext.startsWith("v1.")).toBe(true);
    expect(lic?.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(lic?.keyLast4).toHaveLength(4);
    const key = decryptLicenseKey(lic?.keyCiphertext ?? "", getLicenseKeySecrets().encKey);
    const outbox = await db.outboxEmail.findMany({ where: { dedupeKey: { in: [`order_confirmation:${orderId}`, `license_issued:${lic?.id}`] } } });
    expect(outbox.map((m) => m.templateId).sort()).toEqual(["license_issued", "order_confirmation"]);
    const audits = await db.auditLog.findMany({ where: { targetType: "order", targetId: orderId } });
    expect(audits.map((a) => a.action)).toEqual(["Recorded offline payment"]);
    expect(audits[0]?.reason).toBe(REASON);
    expect(audits[0]?.detail).toContain("UPI · ref UTR 4211 0098");
    for (const text of [...outbox.flatMap((m) => [m.html, m.text, m.subject]), ...audits.map((a) => `${a.detail}`)]) expect(text).not.toContain(key);
    expect(await db.couponRedemption.count({ where: { orderId } })).toBe(1);
  });

  it("fulfils exactly once on a double submit: sequential, concurrent and by another staff member", async () => {
    const payload = await offlineInput();
    const before = await invoiceCounter();
    const first = await createOfflinePaidOrder(payload, ctxOf(finance));
    const afterFirst = await invoiceCounter();
    const again = await createOfflinePaidOrder(payload, ctxOf(finance));
    expect(again).toMatchObject({ orderId: first.orderId, invoiceNumber: first.invoiceNumber, replayed: true, licensesIssued: 1 });
    expect(await invoiceCounter()).toBe(afterFirst);
    expect(afterFirst).not.toBe(before);
    expect(await db.order.count({ where: { staffRequestId: payload.requestId } })).toBe(1);
    expect(await db.invoice.count({ where: { orderId: first.orderId } })).toBe(1);
    expect(await db.license.count({ where: { orderId: first.orderId } })).toBe(1);

    const racing = await offlineInput();
    const results = await Promise.all([createOfflinePaidOrder(racing, ctxOf(finance)), createOfflinePaidOrder(racing, ctxOf(finance))]);
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await db.order.count({ where: { staffRequestId: racing.requestId } })).toBe(1);
    expect(await db.license.count({ where: { orderId: results[0]?.orderId } })).toBe(1);

    const e = await apiError(createOfflinePaidOrder(payload, ctxOf(owner)));
    expect([e.status, e.code]).toEqual([409, "duplicate_request"]);
  });

  it("answers a racing double submit with the first order when it used a limited coupon's last slot (review fix)", async () => {
    const coupon = await makeCoupon({ type: "PERCENT", value: 10, maxRedemptions: 1 });
    const racing = await offlineInput({ couponCode: coupon });
    const results = await Promise.all([createOfflinePaidOrder(racing, ctxOf(finance)), createOfflinePaidOrder(racing, ctxOf(finance))]);
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(1);
    expect(await db.order.count({ where: { staffRequestId: racing.requestId } })).toBe(1);
    expect(await db.couponRedemption.count({ where: { couponCode: coupon } })).toBe(1);
    expect(await db.license.count({ where: { orderId: results[0]?.orderId } })).toBe(1);

    const link = input({ couponCode: await makeCoupon({ type: "PERCENT", value: 10, maxRedemptions: 1 }) });
    const links = await Promise.all([createPaymentLinkOrder(link, ctxOf(finance)), createPaymentLinkOrder(link, ctxOf(finance))]);
    expect(new Set(links.map((r) => r.orderId)).size).toBe(1);
    expect(await db.order.count({ where: { staffRequestId: link.requestId } })).toBe(1);
  });

  it("refuses a wrong amount, a date out of range and a missing reference, storing nothing", async () => {
    const wrong = await offlineInput({ amountPaise: 100 });
    const amount = await apiError(createOfflinePaidOrder(wrong, ctxOf(finance)));
    expect([amount.status, amount.code]).toEqual([422, "validation_failed"]);
    expect(Object.keys((amount.details as { fieldErrors: object }).fieldErrors)).toEqual(["amountPaise"]);
    expect(await db.order.count({ where: { staffRequestId: wrong.requestId } })).toBe(0);

    const tomorrow = istToday(new Date(Date.now() + 86_400_000));
    const old = istToday(new Date(Date.now() - 200 * 86_400_000));
    for (const receivedOn of [tomorrow, old]) {
      const e = await apiError(createOfflinePaidOrder(await offlineInput({ receivedOn }), ctxOf(finance)));
      expect(Object.keys((e.details as { fieldErrors: object }).fieldErrors), receivedOn).toEqual(["receivedOn"]);
    }

    const noRef = makeAdminOrderInput(account, cat.plans, { method: "upi", receivedOn: istToday(new Date()), amountPaise: 1 });
    const res = await post(offlineRoute.POST, "/api/admin/orders/offline", callers.FINANCE, noRef);
    expect(res.status).toBe(422);
    expect((await body(res)).error?.fieldErrors).toMatchObject({ reference: ["Enter the UTR or reference number."] });
    const cheque = await post(offlineRoute.POST, "/api/admin/orders/offline", callers.FINANCE, { ...noRef, method: "cheque" });
    expect((await body(cheque)).error?.fieldErrors).toMatchObject({ reference: ["Enter the cheque number."] });
  });

  it("answers 409 fulfilment_failed when a target license is revoked between the quote and the submit, and stores nothing", async () => {
    const target = await issueTestLicense(account.accountId, cat, cat.plans.annual, new Date());
    const payload = await offlineInput({ items: [{ planId: cat.plans.annual.id, qty: 1, kind: "RENEWAL", targetLicenseId: target.id }] });
    const counter = await invoiceCounter();
    hooks.afterPrice = async () => {
      await db.license.update({ where: { id: target.id }, data: { status: "REVOKED", revokedAt: new Date(), revokedReason: "Test" } });
    };
    const e = await apiError(createOfflinePaidOrder(payload, ctxOf(finance)));
    expect([e.status, e.code]).toEqual([409, "fulfilment_failed"]);
    expect(e.message).toContain("target_revoked");
    expect(await db.order.count({ where: { staffRequestId: payload.requestId } })).toBe(0);
    expect(await db.payment.count({ where: { providerOrderId: { startsWith: "offline:" }, order: { staffRequestId: payload.requestId } } })).toBe(0);
    expect(await invoiceCounter()).toBe(counter);
  });

  it("offers the billing of the account by default and validates it like checkout", async () => {
    const bad = makeAdminOrderInput(account, cat.plans, { billing: adminOrderBilling(account.ownerEmail, { gstin: "29ABCDE1234F1Z5" }) });
    const res = await post(createRoute.POST, "/api/admin/orders", callers.FINANCE, bad);
    expect(res.status).toBe(422);
    expect(Object.keys(((await body(res)).error?.fieldErrors as object) ?? {})).toEqual(["billing.gstin"]);
  });
});
