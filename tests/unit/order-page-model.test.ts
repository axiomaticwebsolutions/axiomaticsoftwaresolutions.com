import { describe, expect, it } from "vitest";
import {
  heroActions,
  heroFor,
  invoiceInputFrom,
  isPaidStatus,
  isPollingStatus,
  licenseLimitLabel,
  licenseTermLabel,
  orderPaths,
  pollDecision,
  POLL_WINDOW_MS,
  SETTLE_WINDOW_MS,
  type OrderStatusName,
} from "@/components/store/order/order-model";
import { REGISTER_PREFILL_KEY, saveRegisterPrefill, takeRegisterPrefill } from "@/components/store/order/session-keys";
import { orderTokenFrom } from "@/lib/checkout/request";
import { buildInvoiceModel } from "@/lib/invoice/model";
import type { OrderStatusDto } from "@/lib/orders/status";
import { ORDER_TOKEN_HEADER } from "@/lib/orders/token-header";

function dto(over: Partial<OrderStatusDto> = {}): OrderStatusDto {
  return {
    id: "AX-10312",
    status: "CONFIRMING",
    failReason: null,
    createdAt: "2026-10-06T22:32:00.000Z",
    paidAt: null,
    email: "rahul@example.com",
    billing: { name: "Rahul Verma", email: "rahul@example.com", phone: "9820012345", business: null, address: "12 MG Road", city: "Pune", state: "Maharashtra", pin: "411001", gstin: null },
    placeOfSupply: "Maharashtra",
    couponCode: null,
    totals: { subtotalPaise: 499_900, discountPaise: 0, taxablePaise: 499_900, cgstPaise: 44_991, sgstPaise: 44_991, igstPaise: 0, totalPaise: 589_882 },
    items: [{ planName: "Annual license", productName: "Medical Store Billing Software", productId: "medical-billing", kind: "NEW", qty: 1, unitPricePaise: 499_900, discountPaise: 0, taxablePaise: 499_900, taxPaise: 89_982, targetLicenseId: null }],
    invoice: null,
    creditNotes: [],
    placedByStaff: false,
    canceledByStaff: false,
    termsRequired: false,
    licenses: [],
    canRetry: false,
    canClaim: true,
    provider: "mock",
    ...over,
  };
}

const LICENSE = { id: "LIC-24100", productId: "medical-billing", productName: "Medical Store Billing Software", planName: "Annual license", keyMasked: "MED-••••-••••-••••-K8NM", status: "active" as const, expiresAt: "2027-10-06T22:33:00.000Z", updatesUntil: "2027-10-06T22:33:00.000Z", deviceLimit: 1 };
const links = { invoicePdf: "/api/orders/AX-10312/invoice.pdf?t=x" };
const INVOICE = { number: "AXS/26-27/1181", issuedAt: "2026-10-06T22:33:00.000Z", replaces: null };

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

describe("order page hero", () => {
  it("uses the prototype copy and tone per status", () => {
    expect(heroFor(dto())).toMatchObject({ tone: "blue", spinning: true, checklist: true, title: "Confirming your payment…" });
    expect(heroFor(dto(), { timedOut: true })).toMatchObject({ tone: "blue", spinning: false, title: "Still confirming your payment" });
    expect(heroFor(dto({ status: "PENDING" }))).toMatchObject({ tone: "peach", icon: "schedule", title: "Payment pending with your bank" });
    expect(heroFor(dto({ status: "CANCELED" }))).toMatchObject({ tone: "slate", icon: "cancel", title: "Payment canceled" });
    expect(heroFor(dto({ status: "AWAITING_PAYMENT" }))).toMatchObject({ tone: "slate", icon: "payments", title: "Waiting for payment" });
    expect(heroFor(dto({ status: "REVIEW" }))).toMatchObject({ tone: "peach", icon: "policy" });
    expect(heroFor(dto({ status: "REFUNDED" }))).toMatchObject({ tone: "slate", title: "Order refunded" });
    expect(heroFor(dto({ status: "PARTIALLY_REFUNDED" }))).toMatchObject({ title: "Order partly refunded" });
  });

  it("starts the failure copy with the reason, and never promises a key by email", () => {
    expect(heroFor(dto({ status: "FAILED", failReason: "Your bank declined the payment." })).body).toBe(
      "Your bank declined the payment. No license was issued. If money left your account, your bank will reverse it automatically. Your cart is saved.",
    );
    expect(heroFor(dto({ status: "FAILED" })).body.startsWith("The payment didn’t go through. ")).toBe(true);
    const paid = heroFor(dto({ status: "PAID", licenses: [LICENSE] }));
    expect(paid).toMatchObject({ tone: "sage", icon: "check_circle", title: "Payment confirmed — your software is ready" });
    expect(paid.body).toContain("rahul@example.com");
    expect(paid.body).not.toMatch(/license key and/);
    expect(heroFor(dto({ status: "PAID" })).title).toBe("Payment confirmed");
  });

  it("offers the prototype's actions per status", () => {
    const labels = (status: OrderStatusName, over: Partial<OrderStatusDto> = {}, timedOut = false) =>
      heroActions(dto({ status, ...over }), links, { timedOut }).map((a) => a.label);
    expect(labels("PAID", { invoice: INVOICE })).toEqual(["Download invoice"]);
    expect(labels("PAID")).toEqual([]);
    expect(labels("FAILED", { canRetry: true })).toEqual(["Try again", "Back to checkout"]);
    expect(labels("FAILED")).toEqual(["Back to checkout"]);
    expect(labels("CANCELED", { canRetry: true })).toEqual(["Return to payment", "Edit order"]);
    expect(labels("AWAITING_PAYMENT", { canRetry: true })).toEqual(["Return to payment", "Edit order"]);
    expect(labels("PENDING")).toEqual(["Contact support"]);
    expect(labels("PENDING", {}, true)).toEqual(["Contact support", "Refresh status"]);
    expect(labels("CONFIRMING")).toEqual([]);
    expect(labels("CONFIRMING", {}, true)).toEqual(["Refresh status"]);
    expect(labels("REVIEW")).toEqual([]);
    const pdf = heroActions(dto({ status: "PAID", invoice: INVOICE }), links)[0];
    expect(pdf && "href" in pdf ? pdf.href : null).toBe(links.invoicePdf);
  });

  it("polls only while the payment settles", () => {
    const statuses: OrderStatusName[] = ["CONFIRMING", "PENDING", "PAID", "FAILED", "CANCELED", "AWAITING_PAYMENT", "REVIEW", "REFUNDED"];
    expect(statuses.filter(isPollingStatus)).toEqual(["CONFIRMING", "PENDING"]);
    expect(isPaidStatus("PAID") && isPaidStatus("PARTIALLY_REFUNDED") && !isPaidStatus("REFUNDED")).toBe(true);
  });
});

describe("order page labels and paths", () => {
  it("labels license limits and terms like the prototype", () => {
    expect(licenseLimitLabel(1, null)).toBe("1 computer");
    expect(licenseLimitLabel(3, null)).toBe("3 computers");
    expect(licenseLimitLabel(4, "terminal")).toBe("4 terminals");
    expect(licenseTermLabel(LICENSE)).toBe("valid until 7 Oct 2027");
    expect(licenseTermLabel({ expiresAt: null, updatesUntil: "2027-10-06T22:33:00.000Z" })).toBe("no expiry · updates until Oct 2027");
  });

  it("builds same-origin paths that carry the link token only when there is one, never in the status poll URL", () => {
    expect(orderPaths("AX-10312", "o1.a.b.c")).toMatchObject({
      status: "/api/orders/AX-10312/status",
      statusHeaders: { "x-order-token": "o1.a.b.c" },
      invoicePdf: "/api/orders/AX-10312/invoice.pdf?t=o1.a.b.c",
      retry: "/api/checkout/orders/AX-10312/retry",
    });
    expect(orderPaths("AX-10312", null)).toMatchObject({ status: "/api/orders/AX-10312/status", statusHeaders: {} });
  });

  it("reads the order link token from the body, then the X-Order-Token header, then ?t=", () => {
    const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });
    const base = "http://localhost:3000/api/orders/AX-1/status";
    expect(orderTokenFrom(req(`${base}?t=query`, { [ORDER_TOKEN_HEADER]: "header" }), "body")).toBe("body");
    expect(orderTokenFrom(req(`${base}?t=query`, { [ORDER_TOKEN_HEADER]: "header" }))).toBe("header");
    expect(orderTokenFrom(req(`${base}?t=query`, { [ORDER_TOKEN_HEADER]: "  " }))).toBe("query");
    expect(orderTokenFrom(req(`${base}?t=query`))).toBe("query");
    expect(orderTokenFrom(req(base))).toBeNull();
    expect(orderTokenFrom(req(base, { [ORDER_TOKEN_HEADER]: "x".repeat(257) }))).toBeNull();
    expect(orderTokenFrom(req(`${base}?t=${"x".repeat(257)}`))).toBeNull();
  });

  it("feeds the shared invoice model with short product names", () => {
    const m = buildInvoiceModel(
      invoiceInputFrom(dto(), {
        products: { "medical-billing": { shortName: "Medical Store Billing", icon: "medication", tone: "sage", release: null } },
        seller: { legalName: "X", gstin: "27AAAAA0000A1Z5", address: "", city: "Pune", state: "Maharashtra", pin: "411001", sample: true },
        sac: "997331",
        fallbackGstRatePct: 18,
      }),
    );
    expect(m).toMatchObject({ title: "Order summary", isInvoice: false, totalLabel: "Total" });
    expect(m.lines[0]).toMatchObject({ shortName: "Medical Store Billing", detail: "Annual license", grossPaise: 499_900 });
  });

  it("gives a corrected invoice the note naming the invoice it replaces, for the printable invoice card (review fix)", () => {
    const data = {
      products: {},
      seller: { legalName: "X", gstin: "27AAAAA0000A1Z5", address: "", city: "Pune", state: "Maharashtra", pin: "411001", sample: true },
      sac: "997331",
      fallbackGstRatePct: 18,
    };
    const corrected = buildInvoiceModel(
      invoiceInputFrom(
        dto({ status: "PAID", paidAt: INVOICE.issuedAt, invoice: { ...INVOICE, number: "AXS/26-27/1190", replaces: { invoiceNo: "AXS/26-27/1181", creditNoteNo: "AXC/26-27/0004" } } }),
        data,
      ),
    );
    expect(corrected.isInvoice).toBe(true);
    expect(corrected.extraNotes).toEqual([expect.stringContaining("This invoice replaces AXS/26-27/1181, cancelled by credit note AXC/26-27/0004")]);
    expect(buildInvoiceModel(invoiceInputFrom(dto({ status: "PAID", paidAt: INVOICE.issuedAt, invoice: INVOICE }), data)).extraNotes).toEqual([]);
  });
});

describe("polling", () => {
  it("polls settling payments for the 2-minute window, then times out", () => {
    for (const status of ["CONFIRMING", "PENDING"] as const) {
      expect(pollDecision(status, 0)).toBe("poll");
      expect(pollDecision(status, POLL_WINDOW_MS - 1)).toBe("poll");
      expect(pollDecision(status, POLL_WINDOW_MS)).toBe("timeout");
    }
  });

  it("re-checks an unpaid order briefly (a failure webhook can land just after the page opens), silently", () => {
    expect(pollDecision("AWAITING_PAYMENT", 0)).toBe("poll");
    expect(pollDecision("AWAITING_PAYMENT", SETTLE_WINDOW_MS - 1)).toBe("poll");
    expect(pollDecision("AWAITING_PAYMENT", SETTLE_WINDOW_MS)).toBe("stop");
    expect(pollDecision("AWAITING_PAYMENT", POLL_WINDOW_MS + 1)).toBe("stop");
  });

  it("re-checks failed and canceled orders briefly too (a verified return can reopen them as CONFIRMING)", () => {
    for (const status of ["FAILED", "CANCELED"] as const) {
      expect(pollDecision(status, 0)).toBe("poll");
      expect(pollDecision(status, SETTLE_WINDOW_MS)).toBe("stop");
    }
  });

  it("stops for settled orders", () => {
    for (const status of ["PAID", "REVIEW", "REFUNDED", "PARTIALLY_REFUNDED"] as const) {
      expect(pollDecision(status, 0)).toBe("stop");
    }
  });
});

describe("session hand-offs", () => {
  it("stores the register prefill outside the URL", () => {
    const storage = new MemoryStorage();
    saveRegisterPrefill("rahul@example.com", storage);
    expect(JSON.parse(storage.getItem(REGISTER_PREFILL_KEY) ?? "null")).toEqual({ v: 1, email: "rahul@example.com" });
  });

  it("hands the register prefill over once, and ignores junk", () => {
    const storage = new MemoryStorage();
    expect(takeRegisterPrefill(storage)).toBe("");
    saveRegisterPrefill("rahul@example.com", storage);
    expect(takeRegisterPrefill(storage)).toBe("rahul@example.com");
    expect(storage.getItem(REGISTER_PREFILL_KEY)).toBeNull();
    expect(takeRegisterPrefill(storage)).toBe("");
    for (const raw of ["{bad", "\"rahul@example.com\"", JSON.stringify({ v: 2, email: "a@b.co" }), JSON.stringify({ v: 1, email: 5 })]) {
      storage.setItem(REGISTER_PREFILL_KEY, raw);
      expect(takeRegisterPrefill(storage)).toBe("");
    }
    expect(takeRegisterPrefill(null)).toBe("");
  });
});
