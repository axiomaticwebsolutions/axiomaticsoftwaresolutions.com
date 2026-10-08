import { describe, expect, it } from "vitest";
import { dateRangeStart, orderOrderBy, orderSearchWhere, orderWhere } from "@/lib/admin/orders/filters";
import {
  ADMIN_ORDERS_LIST,
  discountLabel,
  drawerItemLabel,
  exportToast,
  formatShortDateTimeIST,
  formatTimeIST,
  gstSplitLabel,
  itemKindLabel,
  itemLabel,
  moneyRounded,
  orderQueryFromState,
  ordersExportHref,
  parseCouponFilter,
  parseDayFilter,
  providerLabel,
  refundConsequence,
  refundTitle,
  refundToast,
  replayToast,
  resendToast,
  taxLabel,
} from "@/lib/admin/orders/model";
import {
  isRefundableStatus,
  isTrialConversion,
  pickPayingPayment,
  readTermsSnapshot,
  refundableAmount,
  reversalOrder,
  termsMatch,
} from "@/lib/admin/orders/refund-rules";
import { parseListState } from "@/lib/url-state";

const at = (iso: string) => new Date(iso);

describe("refund rules", () => {
  const pay = (id: string, status: string, capturedAt: string | null, providerOrderId = `order_${id}`) => ({
    id,
    status,
    providerOrderId,
    providerPaymentId: `pay_${id}`,
    amountPaise: 1000,
    capturedAt: capturedAt ? at(capturedAt) : null,
    createdAt: at("2026-10-01T00:00:00Z"),
  });

  it("picks the payment that paid the order", () => {
    expect(pickPayingPayment([pay("a", "FAILED", null)], null)).toBeNull();
    expect(pickPayingPayment([pay("a", "FAILED", null), pay("b", "CAPTURED", "2026-10-02T00:00:00Z")], null)?.id).toBe("b");
    const two = [pay("a", "CAPTURED", "2026-10-02T00:00:00Z"), pay("b", "REFUNDED", "2026-10-03T00:00:00Z")];
    expect(pickPayingPayment(two, at("2026-10-03T00:00:00Z"))?.id).toBe("b");
    expect(pickPayingPayment(two, null, "order_b")?.id).toBe("b");
    expect(pickPayingPayment(two, null)?.id).toBe("a");
  });

  it("counts pending and processed refunds, never failed ones", () => {
    expect(refundableAmount({ amountPaise: 1000 }, [])).toBe(1000);
    expect(
      refundableAmount({ amountPaise: 1000 }, [
        { amountPaise: 300, status: "PENDING" },
        { amountPaise: 200, status: "PROCESSED" },
        { amountPaise: 500, status: "FAILED" },
      ]),
    ).toBe(500);
    expect(refundableAmount({ amountPaise: 1000 }, [{ amountPaise: 1000, status: "PROCESSED" }])).toBe(0);
    expect(isRefundableStatus("PAID")).toBe(true);
    expect(isRefundableStatus("REVIEW")).toBe(true);
    expect(isRefundableStatus("REFUNDED")).toBe(false);
    expect(isRefundableStatus("AWAITING_PAYMENT")).toBe(false);
  });

  it("reads term snapshots defensively and compares instants", () => {
    const snap = { planId: "p", status: "ACTIVE", expiresAt: "2027-01-01T00:00:00.000Z", updatesUntil: "2027-01-01T00:00:00.000Z", deviceLimit: 2 };
    expect(readTermsSnapshot(snap)).toEqual(snap);
    expect(readTermsSnapshot({ ...snap, deviceLimit: -1 })).toBeNull();
    expect(readTermsSnapshot({ ...snap, expiresAt: "soon" })).toBeNull();
    expect(readTermsSnapshot(null)).toBeNull();
    expect(readTermsSnapshot([])).toBeNull();
    expect(termsMatch(snap, { ...snap, expiresAt: "2027-01-01T05:30:00+05:30" })).toBe(true);
    expect(termsMatch(snap, { ...snap, deviceLimit: 3 })).toBe(false);
    expect(termsMatch({ ...snap, expiresAt: null }, snap)).toBe(false);
    expect(termsMatch({ ...snap, status: "SUSPENDED" }, snap)).toBe(false);
    expect(isTrialConversion("UPGRADE", { ...snap, status: "TRIAL" })).toBe(true);
    expect(isTrialConversion("RENEWAL", { ...snap, status: "TRIAL" })).toBe(false);
  });

  it("reverses renewal / add-on / upgrade lines newest first and skips NEW or unfulfilled ones", () => {
    const item = (id: string, kind: string, fulfilled = true, target: string | null = "LIC-1") => ({ id, kind, fulfilledAt: fulfilled ? at("2026-10-01T00:00:00Z") : null, targetLicenseId: target });
    const items = [item("c1", "RENEWAL"), item("c2", "NEW", true, null), item("c3", "ADDON"), item("c4", "UPGRADE", false)];
    expect(reversalOrder(items).map((i) => i.id)).toEqual(["c3", "c1"]);
  });
});

describe("order list filters", () => {
  it("classifies the search so common lookups hit an index", () => {
    expect(orderSearchWhere("")).toBeUndefined();
    expect(orderSearchWhere("ax-10294")).toEqual({ id: { startsWith: "AX-10294" } });
    // Admin records: also an invoice a billing correction cancelled, or the correction's credit note.
    expect(orderSearchWhere("axs/26-27/1058")).toEqual({
      OR: [
        { invoice: { is: { number: "AXS/26-27/1058" } } },
        { invoiceCorrections: { some: { OR: [{ originalInvoiceNo: "AXS/26-27/1058" }, { creditNoteNo: "AXS/26-27/1058" }] } } },
      ],
    });
    expect(orderSearchWhere("pay_1cd7c4efe3df62")).toEqual({
      payments: { some: { OR: [{ providerPaymentId: "pay_1cd7c4efe3df62" }, { providerOrderId: "pay_1cd7c4efe3df62" }] } },
    });
    expect(orderSearchWhere("27abcde1234f1z5")).toEqual({ billing: { path: ["gstin"], equals: "27ABCDE1234F1Z5" } });
    expect(orderSearchWhere("Priya@Example.com")).toEqual({ email: { contains: "Priya@Example.com", mode: "insensitive" } });
    const generic = orderSearchWhere("Rahman") as { OR: unknown[] };
    expect(generic.OR).toHaveLength(8);
    expect(generic.OR).toContainEqual({ billing: { path: ["business"], string_contains: "Rahman", mode: "insensitive" } });
  });

  it("combines filters with AND", () => {
    const now = at("2026-10-07T06:30:00Z");
    expect(orderWhere("", {}, now)).toEqual({});
    const where = orderWhere(
      "",
      { status: "partially_refunded", method: "netbanking", product: "med", coupon: "none", provider: "razorpay", ids: ["AX-1"], from: "2026-10-01", to: "2026-10-05" },
      now,
    ) as { AND: unknown[] };
    expect(where.AND).toEqual([
      { id: { in: ["AX-1"] } },
      { status: "PARTIALLY_REFUNDED" },
      { payments: { some: { method: "Net banking" } } },
      { payments: { some: { provider: "razorpay" } } },
      { items: { some: { plan: { productId: "med" } } } },
      { couponCode: null },
      { createdAt: { gte: at("2026-09-30T18:30:00.000Z"), lte: at("2026-10-05T18:29:59.999Z") } },
    ]);
    expect(orderWhere("", { coupon: "any" }, now)).toEqual({ AND: [{ couponCode: { not: null } }] });
    expect(orderWhere("", { coupon: "DIWALI10" }, now)).toEqual({ AND: [{ couponCode: "DIWALI10" }] });
  });

  it("date presets start in IST", () => {
    const now = at("2026-10-07T20:00:00Z"); // 8 Oct 01:30 IST
    expect(dateRangeStart("today", now).toISOString()).toBe("2026-10-07T18:30:00.000Z");
    expect(dateRangeStart("7d", now).toISOString()).toBe("2026-09-30T20:00:00.000Z");
    expect(dateRangeStart("12m", now).getTime()).toBeLessThan(at("2025-10-09T00:00:00Z").getTime());
  });

  it("sorts ids by creation time and customers by account then email", () => {
    expect(orderOrderBy({ id: "id", desc: true })).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(orderOrderBy({ id: "totalPaise", desc: false })).toEqual([{ totalPaise: "asc" }, { id: "asc" }]);
    expect(orderOrderBy({ id: "customer", desc: false })).toEqual([{ account: { legalName: "asc" } }, { email: "asc" }, { id: "asc" }]);
  });

  it("parses the page URL into the service query and builds export links", () => {
    const state = parseListState(
      new URLSearchParams("q=AX-1&filter[status]=paid&filter[coupon]=diwali10&filter[date]=30d&filter[provider]=nope&sort=totalPaise&page=3"),
      ADMIN_ORDERS_LIST,
    );
    expect(orderQueryFromState(state)).toEqual({
      q: "AX-1",
      filters: { status: "paid", date: "30d", coupon: "DIWALI10" },
      sort: { id: "totalPaise", desc: false },
      page: 3,
      pageSize: 25,
    });
    const href = ordersExportHref(state, ["AX-1", "AX-2"]);
    expect(href.startsWith("/api/admin/orders/export.csv?")).toBe(true);
    const params = new URL(href, "http://x").searchParams;
    expect(params.get("filter[status]")).toBe("paid");
    expect(params.get("ids")).toBe("AX-1,AX-2");
    expect(params.get("page")).toBeNull();
    expect(parseCouponFilter("none")).toBe("none");
    expect(parseCouponFilter("bad code!")).toBeNull();
    expect(parseDayFilter("2026-13-01")).toBeNull();
    expect(parseDayFilter("2026-10-01")).toBe("2026-10-01");
  });
});

describe("order formatting and copy", () => {
  it("formats totals, GST and discounts like the prototype", () => {
    expect(taxLabel({ cgstPaise: 0, sgstPaise: 0, igstPaise: 233_982 })).toBe("IGST");
    expect(taxLabel({ cgstPaise: 10, sgstPaise: 10, igstPaise: 0 })).toBe("CGST+SGST");
    expect(taxLabel({ cgstPaise: 0, sgstPaise: 0, igstPaise: 0 })).toBeNull();
    expect(gstSplitLabel({ cgstPaise: 0, sgstPaise: 0, igstPaise: 233_982 })).toBe("IGST \u20B92,339.82");
    expect(gstSplitLabel({ cgstPaise: 44_991, sgstPaise: 44_991, igstPaise: 0 })).toBe("CGST \u20B9449.91 + SGST \u20B9449.91");
    expect(discountLabel(50_000, "DIWALI10")).toBe("\u2212\u20B9500.00 (DIWALI10)");
    expect(discountLabel(0, "DIWALI10")).toBeNull();
    expect(moneyRounded(3_144_082)).toBe("\u20B931,441");
    expect(itemLabel("Medical Store Billing", "One-time license", 1)).toBe("Medical Store Billing \u00B7 One-time license");
    expect(itemLabel("POS", "Monthly", 3)).toBe("POS \u00B7 Monthly \u00D73");
    expect(drawerItemLabel("POS", "Monthly", 3)).toBe("POS \u00B7 Monthly \u00D7 3");
    expect(itemKindLabel("RENEWAL", "LIC-1")).toBe("Renewal of LIC-1");
    expect(itemKindLabel("NEW", null)).toBe("New");
  });

  it("formats IST times in the prototype's 12-hour style", () => {
    expect(formatTimeIST("2026-10-04T01:40:00Z")).toBe("7:10 am");
    expect(formatTimeIST("2026-10-04T06:30:00Z")).toBe("12:00 pm");
    expect(formatShortDateTimeIST("2026-10-04T01:40:00Z")).toBe("4 Oct, 7:10 am");
    expect(formatShortDateTimeIST(null)).toBe("\u2014");
  });

  it("writes the refund dialog and toasts", () => {
    expect(refundTitle(1_533_882, "AX-10294")).toBe("Refund \u20B915,338.82 for AX-10294?");
    expect(refundConsequence({ licenseCount: 1, changeCount: 0 })).toBe(
      "Sends a full refund through the payment provider and revokes 1 license issued by this order. A credit note is generated.",
    );
    expect(refundConsequence({ licenseCount: 0, changeCount: 0 })).toBe("Sends a full refund through the payment provider. A credit note is generated.");
    expect(refundConsequence({ licenseCount: 2, changeCount: 1 })).toContain("revokes 2 licenses");
    expect(refundConsequence({ licenseCount: 2, changeCount: 1 })).toContain("flagged for review");
    expect(refundToast({ revokedLicenseIds: ["L"], reversedLicenseIds: [], review: false })).toBe("Refund issued \u00B7 licenses revoked");
    expect(refundToast({ revokedLicenseIds: [], reversedLicenseIds: [], review: true })).toBe("Refund issued \u00B7 order flagged for review");
    expect(refundToast({ revokedLicenseIds: [], reversedLicenseIds: [], review: false })).toBe("Refund issued");
    expect(replayToast({ eventId: "evt_7Qm2pX", provider: "razorpay", result: "duplicate_ignored" })).toBe(
      "Replayed evt_7Qm2pX \u2192 duplicate_ignored (idempotent, nothing re-issued)",
    );
    expect(resendToast({ queued: ["a", "b"], skipped: [{ id: "c", reason: "No invoice yet" }] })).toBe("2 invoice emails queued \u00B7 1 skipped");
    expect(resendToast({ queued: ["a"], skipped: [] })).toBe("1 invoice email queued");
    expect(exportToast(12, "orders.csv", false)).toBe("Exported 12 rows \u00B7 orders.csv");
    expect(providerLabel("razorpay", true)).toBe("Razorpay (test)");
    expect(providerLabel("razorpay", false)).toBe("Razorpay");
    expect(providerLabel("mock", false)).toBe("Mock (test)");
  });
});
