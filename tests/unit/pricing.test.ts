import { describe, expect, it } from "vitest";

import { CouponType, ItemKind, PlanType } from "@/generated/prisma/enums";
import { addDays, endOfDayIST, startOfDayIST } from "@/lib/dates";
import { formatINR, withTax } from "@/lib/money";
import {
  COUPON_MESSAGES,
  DEFAULT_MAX_QTY,
  ITEM_KIND_PLAN_TYPES,
  PricingError,
  allocateLargestRemainder,
  evaluateCoupon,
  gstSplit,
  isItemKindAllowed,
  normalizeCouponCode,
  normalizeQuantity,
  quote,
  type CartLine,
  type CouponRule,
  type PricingPlan,
  type Quote,
  type QuoteLine,
} from "@/lib/pricing";

// ---- fixtures: sample plans and coupons from prototype/axiomatic-data.js

const plan = (
  id: string,
  productId: string,
  type: PlanType,
  pricePaise: number,
  extra: Partial<PricingPlan> = {},
): PricingPlan => ({ id, productId, type, pricePaise, perUnit: null, maxQty: null, ...extra });

const PLAN_LIST: PricingPlan[] = [
  plan("med-trial", "medical-billing", PlanType.TRIAL, 0),
  plan("med-annual", "medical-billing", PlanType.ANNUAL, 499900),
  plan("med-onetime", "medical-billing", PlanType.ONE_TIME, 1299900),
  plan("med-device", "medical-billing", PlanType.DEVICE_ADDON, 249900),
  plan("med-amc", "medical-billing", PlanType.MAINTENANCE, 299900),
  plan("rst-trial", "restaurant-billing", PlanType.TRIAL, 0),
  plan("rst-monthly", "restaurant-billing", PlanType.SUBSCRIPTION, 69900, { perUnit: "terminal", maxQty: 10 }),
  plan("rst-yearly", "restaurant-billing", PlanType.SUBSCRIPTION, 699900, { perUnit: "terminal", maxQty: 10 }),
  plan("gst-trial", "general-store-gst", PlanType.TRIAL, 0),
  plan("gst-annual", "general-store-gst", PlanType.ANNUAL, 349900),
  plan("gst-onetime", "general-store-gst", PlanType.ONE_TIME, 799900),
  plan("gst-multi", "general-store-gst", PlanType.ONE_TIME, 1999900),
  plan("gst-amc", "general-store-gst", PlanType.MAINTENANCE, 199900),
  plan("chq-onetime", "cheque-printing", PlanType.ONE_TIME, 299900),
  plan("chq-office", "cheque-printing", PlanType.ONE_TIME, 699900),
  plan("chq-amc", "cheque-printing", PlanType.MAINTENANCE, 99900),
  plan("med-annual-2025", "medical-billing", PlanType.ANNUAL, 449900, { archived: true }),
];
const PLANS: ReadonlyMap<string, PricingPlan> = new Map(PLAN_LIST.map((p) => [p.id, p]));
const TAX = { gstRatePct: 18, companyState: "Maharashtra" };
const NOW = new Date("2026-10-06T06:00:00Z");

const coupon = (rule: Partial<CouponRule> & Pick<CouponRule, "code" | "type" | "value">): CouponRule => ({
  label: `${rule.code} label`,
  minSubtotal: null,
  productIds: [],
  planTypes: [],
  startsAt: addDays(NOW, -90),
  endsAt: addDays(NOW, 60),
  maxRedemptions: null,
  redemptions: 0,
  active: true,
  ...rule,
});

const WELCOME10 = coupon({
  code: "WELCOME10",
  type: CouponType.PERCENT,
  value: 10,
  minSubtotal: 200000,
  maxRedemptions: 200,
  redemptions: 14,
  label: "10% off orders above ₹2,000",
});
const ANNUAL500 = coupon({
  code: "ANNUAL500",
  type: CouponType.FLAT,
  value: 50000,
  planTypes: [PlanType.ANNUAL, PlanType.SUBSCRIPTION],
  label: "₹500 off annual and subscription plans",
});
const CHEQUE15 = coupon({
  code: "CHEQUE15",
  type: CouponType.PERCENT,
  value: 15,
  productIds: ["cheque-printing"],
  label: "15% off Cheque Printing",
});
const MONSOON25 = coupon({
  code: "MONSOON25",
  type: CouponType.PERCENT,
  value: 25,
  startsAt: startOfDayIST("2026-06-01"),
  endsAt: endOfDayIST("2026-08-31"),
  label: "Expired sample code",
});
const DIWALI20 = coupon({
  code: "DIWALI20",
  type: CouponType.PERCENT,
  value: 20,
  planTypes: [PlanType.ANNUAL],
  startsAt: startOfDayIST("2026-10-20"),
  endsAt: endOfDayIST("2026-11-03"),
});
const FIRSTPC = coupon({
  code: "FIRSTPC",
  type: CouponType.FLAT,
  value: 100000,
  minSubtotal: 700000,
  planTypes: [PlanType.ONE_TIME],
  active: false,
});
const FULL100 = coupon({ code: "FULL100", type: CouponType.PERCENT, value: 100, maxRedemptions: 100, redemptions: 100 });
const COUPONS: ReadonlyMap<string, CouponRule> = new Map(
  [WELCOME10, ANNUAL500, CHEQUE15, MONSOON25, DIWALI20, FIRSTPC, FULL100].map((c) => [c.code, c]),
);

function q(lines: CartLine[], opts: { state?: string | null; code?: string | null; now?: Date } = {}): Quote {
  const code = opts.code ?? null;
  return quote({
    lines,
    plans: PLANS,
    tax: TAX,
    billingState: opts.state === undefined ? "Maharashtra" : opts.state,
    couponCode: code,
    coupon: code ? (COUPONS.get(normalizeCouponCode(code)) ?? null) : null,
    now: opts.now ?? NOW,
  });
}

const sumOf = (lines: readonly QuoteLine[], pick: (line: QuoteLine) => number) =>
  lines.reduce((acc, line) => acc + pick(line), 0);

/** Every invariant the order header and its lines must satisfy. */
function expectInvariants(r: Quote): void {
  expect(sumOf(r.lines, (l) => l.amountPaise)).toBe(r.subtotalPaise);
  expect(sumOf(r.lines, (l) => l.discountPaise)).toBe(r.discountPaise);
  expect(sumOf(r.lines, (l) => l.taxablePaise)).toBe(r.taxablePaise);
  expect(sumOf(r.lines, (l) => l.taxPaise)).toBe(r.gstPaise);
  expect(r.taxablePaise).toBe(r.subtotalPaise - r.discountPaise);
  expect(r.totalPaise).toBe(r.taxablePaise + r.gstPaise);
  expect(r.gstPaise).toBe(Math.round((r.taxablePaise * r.gstRatePct) / 100));
  expect(r.cgstPaise + r.sgstPaise + r.igstPaise).toBe(r.gstPaise);
  if (r.intraState) {
    expect(r.igstPaise).toBe(0);
    expect(r.cgstPaise).toBe(Math.round(r.gstPaise / 2));
  } else {
    expect(r.cgstPaise + r.sgstPaise).toBe(0);
  }
  expect(r.discountPaise).toBe(r.coupon?.ok ? r.coupon.discountPaise : 0);
  for (const l of r.lines) {
    expect(l.amountPaise).toBe(l.unitPricePaise * l.qty - l.creditPaise);
    expect(l.taxablePaise).toBe(l.amountPaise - l.discountPaise);
    for (const v of [l.amountPaise, l.creditPaise, l.discountPaise, l.taxablePaise, l.taxPaise]) {
      expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
    }
  }
}

describe("GST (decisions.md section 3)", () => {
  it("1) med-annual intra-state: CGST + SGST", () => {
    const r = q([{ planId: "med-annual", qty: 1 }]);
    expect(r).toMatchObject({
      subtotalPaise: 499900,
      discountPaise: 0,
      taxablePaise: 499900,
      gstPaise: 89982,
      cgstPaise: 44991,
      sgstPaise: 44991,
      igstPaise: 0,
      totalPaise: 589882,
      gstRatePct: 18,
      intraState: true,
      placeOfSupply: "Maharashtra",
      coupon: null,
    });
    expect(formatINR(withTax(499900))).toBe("₹5,898.82");
    expect(formatINR(r.totalPaise)).toBe("₹5,898.82");
    expect(r.lines).toEqual([
      {
        planId: "med-annual",
        productId: "medical-billing",
        planType: PlanType.ANNUAL,
        kind: ItemKind.NEW,
        qty: 1,
        unitPricePaise: 499900,
        amountPaise: 499900,
        creditPaise: 0,
        discountPaise: 0,
        taxablePaise: 499900,
        taxPaise: 89982,
        targetLicenseId: null,
      },
    ]);
    expectInvariants(r);
  });

  it("2) same cart billed to Karnataka: IGST", () => {
    const r = q([{ planId: "med-annual", qty: 1 }], { state: "Karnataka" });
    expect(r).toMatchObject({ igstPaise: 89982, cgstPaise: 0, sgstPaise: 0, totalPaise: 589882, intraState: false });
    expect(r.placeOfSupply).toBe("Karnataka");
    expectInvariants(r);
  });

  it("treats a missing billing state as intra-state", () => {
    for (const state of [null, ""]) {
      const r = q([{ planId: "med-annual", qty: 1 }], { state });
      expect(r.intraState).toBe(true);
      expect(r.placeOfSupply).toBeNull();
      expect(r.cgstPaise).toBe(44991);
    }
  });

  it("gstSplit rounds GST once, then CGST half-up and SGST as the rest", () => {
    expect(gstSplit(499900, 18, true)).toEqual({ gstPaise: 89982, cgstPaise: 44991, sgstPaise: 44991, igstPaise: 0 });
    expect(gstSplit(254915, 18, true)).toEqual({ gstPaise: 45885, cgstPaise: 22943, sgstPaise: 22942, igstPaise: 0 });
    expect(gstSplit(254915, 18, false)).toEqual({ gstPaise: 45885, cgstPaise: 0, sgstPaise: 0, igstPaise: 45885 });
    expect(gstSplit(0, 18, true)).toEqual({ gstPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
    expect(gstSplit(100000, 0, true).gstPaise).toBe(0);
    expect(gstSplit(1, 18, true)).toEqual({ gstPaise: 0, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
    expect(gstSplit(3, 18, true)).toEqual({ gstPaise: 1, cgstPaise: 1, sgstPaise: 0, igstPaise: 0 });
  });

  it("gstSplit rejects bad input", () => {
    expect(() => gstSplit(-1, 18, true)).toThrow(RangeError);
    expect(() => gstSplit(1.5, 18, true)).toThrow(TypeError);
    expect(() => gstSplit(100, 101, true)).toThrow(RangeError);
    expect(() => gstSplit(100, Number.NaN, true)).toThrow(RangeError);
  });
});

describe("coupons", () => {
  it("3) CHEQUE15 on chq-onetime", () => {
    const r = q([{ planId: "chq-onetime", qty: 1 }], { code: "CHEQUE15" });
    expect(r).toMatchObject({
      subtotalPaise: 299900,
      discountPaise: 44985,
      taxablePaise: 254915,
      gstPaise: 45885,
      cgstPaise: 22943,
      sgstPaise: 22942,
      igstPaise: 0,
      totalPaise: 300800,
    });
    expect(r.coupon).toEqual({ ok: true, code: "CHEQUE15", label: "15% off Cheque Printing", discountPaise: 44985 });
    expectInvariants(r);
  });

  it("4) WELCOME10 below the minimum subtotal", () => {
    const r = q([{ planId: "rst-monthly", qty: 1 }], { code: "WELCOME10" });
    expect(r.coupon).toEqual({
      ok: false,
      code: "WELCOME10",
      reason: "min_subtotal",
      message: "Add ₹1,301 more to use this code.",
    });
    expect(r.discountPaise).toBe(0);
    expect(r.totalPaise).toBe(withTax(69900));
    expectInvariants(r);
  });

  it("4b) WELCOME10 minimum counts the whole cart and per-unit quantity", () => {
    const r = q([{ planId: "rst-monthly", qty: 3 }], { code: "WELCOME10" });
    expect(r.subtotalPaise).toBe(209700);
    expect(r.coupon).toMatchObject({ ok: true, discountPaise: 20970 });
    expectInvariants(r);
  });

  it("5) WELCOME10 on med-annual", () => {
    const r = q([{ planId: "med-annual", qty: 1 }], { code: "WELCOME10" });
    expect(r).toMatchObject({
      discountPaise: 49990,
      taxablePaise: 449910,
      gstPaise: 80984,
      cgstPaise: 40492,
      sgstPaise: 40492,
      totalPaise: 530894,
    });
    expect(r.coupon).toMatchObject({ ok: true, label: "10% off orders above ₹2,000" });
    expectInvariants(r);
  });

  it("6) ANNUAL500 does not apply to a one-time license", () => {
    const r = q([{ planId: "chq-onetime", qty: 1 }], { code: "ANNUAL500" });
    expect(r.coupon).toEqual({
      ok: false,
      code: "ANNUAL500",
      reason: "not_applicable",
      message: "This code doesn’t apply to the items in your cart.",
    });
    expect(r.discountPaise).toBe(0);
  });

  it("7) ANNUAL500 on gst-annual takes ₹500 off", () => {
    const r = q([{ planId: "gst-annual", qty: 1 }], { code: "ANNUAL500" });
    expect(r.discountPaise).toBe(50000);
    expect(r.taxablePaise).toBe(299900);
    expectInvariants(r);
  });

  it("8) MONSOON25 expired at the end of 31 Aug 2026 IST", () => {
    expect(MONSOON25.endsAt.toISOString()).toBe("2026-08-31T18:29:59.999Z");
    const r = q([{ planId: "med-annual", qty: 1 }], { code: "MONSOON25" });
    expect(r.coupon).toEqual({
      ok: false,
      code: "MONSOON25",
      reason: "expired",
      message: "This code expired on 31 Aug 2026.",
    });
    const lastMoment = q([{ planId: "med-annual", qty: 1 }], { code: "MONSOON25", now: MONSOON25.endsAt });
    expect(lastMoment.coupon?.ok).toBe(true);
    const justAfter = q([{ planId: "med-annual", qty: 1 }], {
      code: "MONSOON25",
      now: new Date(MONSOON25.endsAt.getTime() + 1),
    });
    expect(justAfter.coupon).toMatchObject({ ok: false, reason: "expired" });
  });

  it("9) unknown, normalised, paused, scheduled and used-up codes", () => {
    const cart: CartLine[] = [{ planId: "med-annual", qty: 1 }];
    expect(q(cart, { code: "NOPE" }).coupon).toEqual({
      ok: false,
      code: "NOPE",
      reason: "not_found",
      message: "This code isn’t valid. Check the spelling and try again.",
    });
    expect(normalizeCouponCode(" welcome10 ")).toBe("WELCOME10");
    expect(q(cart, { code: " welcome10 " }).coupon).toMatchObject({ ok: true, code: "WELCOME10" });

    const paused = q([{ planId: "chq-office", qty: 1 }, { planId: "gst-onetime", qty: 1 }], { code: "firstpc" });
    expect(paused.coupon).toEqual({ ok: false, code: "FIRSTPC", reason: "paused", message: COUPON_MESSAGES.invalid });

    expect(q(cart, { code: "DIWALI20" }).coupon).toEqual({
      ok: false,
      code: "DIWALI20",
      reason: "not_started",
      message: "This code starts on 20 Oct 2026.",
    });
    expect(q(cart, { code: "DIWALI20", now: DIWALI20.startsAt }).coupon?.ok).toBe(true);

    expect(q(cart, { code: "FULL100" }).coupon).toEqual({
      ok: false,
      code: "FULL100",
      reason: "limit_reached",
      message: "This code has reached its usage limit.",
    });
  });

  it("checks rules in the documented order", () => {
    const cart: CartLine[] = [{ planId: "chq-onetime", qty: 1 }];
    const check = (rule: CouponRule) =>
      evaluateCoupon({ code: rule.code, coupon: rule, lines: cart, plans: PLANS, now: NOW });
    const everythingWrong = coupon({
      code: "BAD",
      type: CouponType.PERCENT,
      value: 10,
      active: false,
      startsAt: addDays(NOW, 5),
      endsAt: addDays(NOW, -5),
      maxRedemptions: 1,
      redemptions: 1,
      productIds: ["medical-billing"],
      minSubtotal: 10_000_000,
    });
    expect(check(everythingWrong)).toMatchObject({ reason: "paused" });
    expect(check({ ...everythingWrong, active: true })).toMatchObject({ reason: "not_started" });
    expect(check({ ...everythingWrong, active: true, startsAt: addDays(NOW, -10) })).toMatchObject({
      reason: "expired",
    });
    const live = { ...everythingWrong, active: true, startsAt: addDays(NOW, -10), endsAt: addDays(NOW, 10) };
    expect(check(live)).toMatchObject({ reason: "limit_reached" });
    expect(check({ ...live, maxRedemptions: null })).toMatchObject({ reason: "not_applicable" });
    expect(check({ ...live, maxRedemptions: null, productIds: [] })).toMatchObject({
      reason: "min_subtotal",
      message: "Add ₹97,001 more to use this code.",
    });
  });
});

describe("coupon allocation and edge cases", () => {
  it("10) CHEQUE15 on a mixed cart discounts only the cheque line", () => {
    const r = q([{ planId: "chq-onetime", qty: 1 }, { planId: "med-annual", qty: 1 }], { code: "CHEQUE15" });
    expect(r.subtotalPaise).toBe(799800);
    expect(r.discountPaise).toBe(44985);
    expect(r.lines.map((l) => l.discountPaise)).toEqual([44985, 0]);
    expect(r.lines.map((l) => l.taxablePaise)).toEqual([254915, 499900]);
    expect(r.taxablePaise).toBe(754815);
    expect(r.gstPaise).toBe(135867);
    expectInvariants(r);
  });

  it("caps FLAT and 100% discounts at the eligible amount", () => {
    const flat = coupon({ code: "BIG", type: CouponType.FLAT, value: 10_000_000, productIds: ["cheque-printing"] });
    const cart: CartLine[] = [{ planId: "chq-amc", qty: 1, kind: ItemKind.RENEWAL, targetLicenseId: "LIC-1" }];
    expect(evaluateCoupon({ code: "big", coupon: flat, lines: cart, plans: PLANS, now: NOW })).toMatchObject({
      ok: true,
      discountPaise: 99900,
    });
    const free = coupon({ code: "FREE", type: CouponType.PERCENT, value: 100 });
    const r = quote({ lines: cart, plans: PLANS, tax: TAX, couponCode: "FREE", coupon: free, now: NOW });
    expect(r).toMatchObject({ discountPaise: 99900, taxablePaise: 0, gstPaise: 0, totalPaise: 0 });
    expectInvariants(r);
  });

  it("ignores blank coupon codes and reports a missing coupon row as not found", () => {
    const cart: CartLine[] = [{ planId: "med-annual", qty: 1 }];
    for (const couponCode of [undefined, null, "", "   "]) {
      expect(quote({ lines: cart, plans: PLANS, tax: TAX, couponCode, coupon: WELCOME10, now: NOW }).coupon).toBeNull();
    }
    expect(quote({ lines: cart, plans: PLANS, tax: TAX, couponCode: "WELCOME10", now: NOW }).coupon).toMatchObject({
      reason: "not_found",
    });
    expect(
      evaluateCoupon({ code: "CHEQUE15", coupon: WELCOME10, lines: cart, plans: PLANS, now: NOW }),
    ).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("evaluateCoupon agrees with quote()", () => {
    const cart: CartLine[] = [{ planId: "rst-yearly", qty: 4 }, { planId: "gst-annual", qty: 1 }];
    const standalone = evaluateCoupon({ code: "ANNUAL500", coupon: ANNUAL500, lines: cart, plans: PLANS, now: NOW });
    expect(standalone).toEqual(q(cart, { code: "ANNUAL500" }).coupon);
    expect(standalone).toMatchObject({ ok: true, discountPaise: 50000 });
  });

  it("prices an empty cart as zero", () => {
    const r = q([]);
    expect(r).toMatchObject({ lines: [], subtotalPaise: 0, gstPaise: 0, totalPaise: 0, coupon: null });
    expect(q([], { code: "WELCOME10" }).coupon).toMatchObject({ reason: "not_applicable" });
  });
});

describe("quantities", () => {
  it("11) per-unit plans multiply and clamp; single-seat plans are qty 1", () => {
    const three = q([{ planId: "rst-yearly", qty: 3 }]);
    expect(three.lines[0]).toMatchObject({ qty: 3, unitPricePaise: 699900, amountPaise: 2099700 });
    expect(q([{ planId: "rst-yearly", qty: 11 }]).lines[0]?.qty).toBe(10);
    expect(q([{ planId: "med-annual", qty: 2 }]).lines[0]).toMatchObject({ qty: 1, amountPaise: 499900 });
    expectInvariants(three);
  });

  it("normalizeQuantity follows the plan type", () => {
    const get = (id: string) => {
      const p = PLANS.get(id);
      if (!p) throw new Error(`missing fixture ${id}`);
      return p;
    };
    expect(normalizeQuantity(get("rst-monthly"), ItemKind.NEW, 7)).toBe(7);
    expect(normalizeQuantity(get("rst-monthly"), ItemKind.RENEWAL, 50)).toBe(10);
    expect(normalizeQuantity(get("med-device"), ItemKind.ADDON, 3)).toBe(3);
    expect(normalizeQuantity(get("med-device"), ItemKind.ADDON, 99)).toBe(DEFAULT_MAX_QTY);
    expect(normalizeQuantity({ ...get("med-device"), maxQty: 4 }, ItemKind.ADDON, 9)).toBe(4);
    expect(normalizeQuantity(get("med-amc"), ItemKind.RENEWAL, 3)).toBe(1);
    expect(normalizeQuantity(get("gst-multi"), ItemKind.NEW, 5)).toBe(1);
    expect(normalizeQuantity(get("med-annual"), ItemKind.RENEWAL, 2)).toBe(1);
    expect(normalizeQuantity({ ...get("rst-yearly"), maxQty: null }, ItemKind.NEW, 12)).toBe(DEFAULT_MAX_QTY);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60])("rejects quantity %s", (qty) => {
    const p = PLANS.get("rst-yearly");
    expect(p).toBeDefined();
    if (!p) return;
    expect(() => normalizeQuantity(p, ItemKind.NEW, qty)).toThrow(PricingError);
    expect(() => q([{ planId: "rst-yearly", qty }])).toThrow(expect.objectContaining({ code: "invalid_quantity" }));
  });
});

function pricingErrorOf(fn: () => unknown): PricingError {
  try {
    fn();
  } catch (error) {
    if (error instanceof PricingError) return error;
    throw error;
  }
  throw new Error("expected a PricingError");
}

describe("PricingError", () => {
  it.each([
    ["nope", 1, undefined, undefined, "unknown_plan"],
    ["med-annual-2025", 1, undefined, undefined, "archived_plan"],
    ["med-trial", 1, undefined, undefined, "trial_not_purchasable"],
    ["med-device", 1, ItemKind.ADDON, undefined, "target_required"],
    ["med-device", 1, ItemKind.NEW, null, "invalid_item_kind"],
    ["med-amc", 1, ItemKind.RENEWAL, "   ", "target_required"],
    ["med-annual", 1, ItemKind.RENEWAL, undefined, "target_required"],
    ["med-annual", 1, ItemKind.UPGRADE, "", "target_required"],
    ["rst-yearly", 0, undefined, undefined, "invalid_quantity"],
  ] as const)("%s qty %s kind %s target %j -> %s", (planId, qty, kind, targetLicenseId, code) => {
    const error = pricingErrorOf(() => q([{ planId: "med-annual", qty: 1 }, { planId, qty, kind, targetLicenseId }]));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PricingError");
    expect(error.code).toBe(code);
    expect(error.planId).toBe(planId);
    expect(error.message.length).toBeGreaterThan(0);
  });

  // Pairs fulfilment always rejects after payment (newLicenseTerms, renewalTerms, upgradeTerms, fulfil ADDON check).
  it.each([
    ["med-device", ItemKind.NEW],
    ["med-amc", ItemKind.NEW],
    ["med-annual", ItemKind.ADDON],
    ["med-amc", ItemKind.ADDON],
    ["med-device", ItemKind.RENEWAL],
    ["med-onetime", ItemKind.RENEWAL],
    ["med-amc", ItemKind.UPGRADE],
    ["med-device", ItemKind.UPGRADE],
  ] as const)("refuses %s as a %s line (invalid_item_kind)", (planId, kind) => {
    const error = pricingErrorOf(() => q([{ planId, qty: 3, kind, targetLicenseId: "LIC-24017" }]));
    expect(error.code).toBe("invalid_item_kind");
    expect(error.planId).toBe(planId);
    expect(error.message).toBe("This plan can’t be bought that way.");
  });

  it("prices exactly the kind / plan type pairs in ITEM_KIND_PLAN_TYPES", () => {
    const sellable = PLAN_LIST.filter((p) => p.type !== PlanType.TRIAL && !p.archived);
    for (const p of sellable) {
      for (const kind of Object.values(ItemKind)) {
        const line: CartLine = { planId: p.id, qty: 1, kind, targetLicenseId: "LIC-24017" };
        const allowed = isItemKindAllowed(kind, p.type);
        expect(allowed).toBe(ITEM_KIND_PLAN_TYPES[kind].includes(p.type));
        if (allowed) expect(q([line]).lines[0]?.kind, `${kind} ${p.id}`).toBe(kind);
        else expect(pricingErrorOf(() => q([line])).code, `${kind} ${p.id}`).toBe("invalid_item_kind");
      }
    }
  });

  it("renews on archived plans but refuses new purchases, upgrades and add-ons on them", () => {
    const archived = new Map(
      [...PLANS].map(([id, p]): [string, PricingPlan] => [id, ["med-annual", "chq-amc", "med-device", "med-onetime"].includes(id) ? { ...p, archived: true } : p]),
    );
    const price = (line: CartLine) => quote({ lines: [line], plans: archived, tax: TAX, billingState: "Maharashtra", now: NOW });
    expect(price({ planId: "med-annual", qty: 1, kind: ItemKind.RENEWAL, targetLicenseId: "LIC-1" }).lines[0]).toMatchObject({
      kind: ItemKind.RENEWAL,
      amountPaise: 499900,
    });
    expect(price({ planId: "chq-amc", qty: 1, kind: ItemKind.RENEWAL, targetLicenseId: "LIC-2" }).totalPaise).toBe(withTax(99900));
    expect(price({ planId: "med-annual-2025", qty: 1, kind: ItemKind.RENEWAL, targetLicenseId: "LIC-3" }).subtotalPaise).toBe(449900);
    for (const line of [
      { planId: "med-annual", qty: 1 },
      { planId: "med-onetime", qty: 1, kind: ItemKind.UPGRADE, targetLicenseId: "LIC-1" },
      { planId: "med-device", qty: 1, kind: ItemKind.ADDON, targetLicenseId: "LIC-1" },
    ]) {
      expect(pricingErrorOf(() => price(line)).code).toBe("archived_plan");
    }
  });

  it("evaluateCoupon validates lines the same way", () => {
    const error = pricingErrorOf(() =>
      evaluateCoupon({ code: "WELCOME10", coupon: WELCOME10, lines: [{ planId: "gst-trial", qty: 1 }], plans: PLANS, now: NOW }),
    );
    expect(error.code).toBe("trial_not_purchasable");
  });
});

describe("targets and credits", () => {
  it("keeps targets on renewals, upgrades and add-ons and drops them on NEW lines", () => {
    const r = q([
      { planId: "med-device", qty: 2, kind: ItemKind.ADDON, targetLicenseId: "LIC-24017" },
      { planId: "med-amc", qty: 1, kind: ItemKind.RENEWAL, targetLicenseId: "LIC-24018" },
      { planId: "med-annual", qty: 1, kind: ItemKind.RENEWAL, targetLicenseId: "LIC-24019" },
      { planId: "gst-onetime", qty: 1, targetLicenseId: "LIC-24020" },
    ]);
    expect(r.lines.map((l) => [l.kind, l.qty, l.targetLicenseId])).toEqual([
      [ItemKind.ADDON, 2, "LIC-24017"],
      [ItemKind.RENEWAL, 1, "LIC-24018"],
      [ItemKind.RENEWAL, 1, "LIC-24019"],
      [ItemKind.NEW, 1, null],
    ]);
    expectInvariants(r);
  });

  it("subtracts server-supplied credit and never goes below zero", () => {
    const upgrade = { planId: "med-onetime", qty: 1, kind: ItemKind.UPGRADE, targetLicenseId: "LIC-1" };
    const r = q([{ ...upgrade, creditPaise: 499900 }]);
    expect(r.lines[0]).toMatchObject({ amountPaise: 800000, creditPaise: 499900 });
    expect(r.subtotalPaise).toBe(800000);
    expectInvariants(r);
    const over = q([{ ...upgrade, creditPaise: 5_000_000 }]);
    expect(over.lines[0]).toMatchObject({ amountPaise: 0, creditPaise: 1299900, taxPaise: 0 });
    expectInvariants(over);
    expect(() => q([{ ...upgrade, creditPaise: -1 }])).toThrow(RangeError);
    expect(() => q([{ ...upgrade, creditPaise: 0.5 }])).toThrow(RangeError);
  });
});

describe("allocateLargestRemainder", () => {
  it("12) splits 100 over three equal weights as 34/33/33", () => {
    expect(allocateLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it("gives leftovers to the largest remainders, ties to the earlier index", () => {
    expect(allocateLargestRemainder(5, [1, 3])).toEqual([1, 4]);
    expect(allocateLargestRemainder(1, [1, 1, 1])).toEqual([1, 0, 0]);
    expect(allocateLargestRemainder(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(allocateLargestRemainder(10, [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(allocateLargestRemainder(7, [0, 5, 0, 5])).toEqual([0, 4, 0, 3]);
    expect(allocateLargestRemainder(0, [5, 5])).toEqual([0, 0]);
  });

  it("spreads over all-zero weights from the first index", () => {
    expect(allocateLargestRemainder(100, [0, 0, 0])).toEqual([34, 33, 33]);
    expect(allocateLargestRemainder(2, [0, 0, 0])).toEqual([1, 1, 0]);
    expect(allocateLargestRemainder(0, [])).toEqual([]);
  });

  it("is exact for large values", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const shares = allocateLargestRemainder(max, [max, 1]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(max);
    expect(allocateLargestRemainder(1_000_000_007, [3, 3, 3])).toEqual([333333336, 333333336, 333333335]);
  });

  it("rejects invalid input", () => {
    expect(() => allocateLargestRemainder(-1, [1])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(1.5, [1])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(10, [1, -1])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(10, [0.5])).toThrow(RangeError);
    expect(() => allocateLargestRemainder(1, [])).toThrow(RangeError);
  });
});

describe("generated carts", () => {
  // Seeded PRNG so failures reproduce; test data only, nothing security-related.
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(20261006);
  const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T,>(items: readonly T[]): T => {
    const item = items[int(0, items.length - 1)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  };

  const PURCHASABLE = PLAN_LIST.filter((p) => p.type !== PlanType.TRIAL && !p.archived);
  const PRODUCTS = [...new Set(PLAN_LIST.map((p) => p.productId))];
  const TYPES = [PlanType.ONE_TIME, PlanType.ANNUAL, PlanType.SUBSCRIPTION, PlanType.DEVICE_ADDON, PlanType.MAINTENANCE];
  const STATES = [null, "Maharashtra", "Karnataka", "Delhi", "Tamil Nadu"];
  const RATES = [0, 5, 12, 18, 28];

  function randomLine(): CartLine {
    const p = pick(PURCHASABLE);
    const kinds = [ItemKind.NEW, ItemKind.NEW, ItemKind.NEW, ItemKind.RENEWAL, ItemKind.ADDON, ItemKind.UPGRADE].filter((k) =>
      isItemKindAllowed(k, p.type),
    );
    const kind = pick(kinds);
    const line: CartLine = { planId: p.id, qty: int(1, 14), kind };
    if (kind !== ItemKind.NEW) line.targetLicenseId = `LIC-${int(1, 99999)}`;
    if (kind === ItemKind.UPGRADE && rand() < 0.5) line.creditPaise = int(0, p.pricePaise * 2);
    return line;
  }

  function randomCoupon(): CouponRule | null {
    if (rand() < 0.15) return null;
    const type = pick([CouponType.PERCENT, CouponType.FLAT]);
    return coupon({
      code: "GEN",
      type,
      value: type === CouponType.PERCENT ? int(1, 100) : int(1, 2_000_000),
      productIds: rand() < 0.5 ? [] : [pick(PRODUCTS)],
      planTypes: rand() < 0.5 ? [] : [pick(TYPES), pick(TYPES)],
      minSubtotal: rand() < 0.3 ? int(0, 3_000_000) : null,
    });
  }

  it("keeps every invariant over 3,000 random carts", () => {
    let discounted = 0;
    for (let n = 0; n < 3000; n++) {
      const lines = Array.from({ length: int(0, 6) }, randomLine);
      const rule = randomCoupon();
      const r = quote({
        lines,
        plans: PLANS,
        tax: { gstRatePct: pick(RATES), companyState: "Maharashtra" },
        billingState: pick(STATES),
        couponCode: rand() < 0.1 ? "" : " gen ",
        coupon: rule,
        now: NOW,
      });
      expectInvariants(r);
      expect(r.lines).toHaveLength(lines.length);
      for (const l of r.lines) {
        expect(l.qty).toBeGreaterThanOrEqual(1);
        expect(l.qty).toBeLessThanOrEqual(DEFAULT_MAX_QTY);
        if (r.taxablePaise > 0) {
          const exactTax = (r.gstPaise * l.taxablePaise) / r.taxablePaise;
          expect(Math.abs(l.taxPaise - exactTax)).toBeLessThan(1 + 1e-9);
        }
        const eligible =
          rule !== null &&
          (rule.productIds.length === 0 || rule.productIds.includes(l.productId)) &&
          (rule.planTypes.length === 0 || rule.planTypes.includes(l.planType));
        if (!eligible) expect(l.discountPaise).toBe(0);
      }
      if (r.discountPaise > 0) discounted += 1;
    }
    // The generator must actually exercise the discount path.
    expect(discounted).toBeGreaterThan(300);
  });

  it("allocates random totals exactly and proportionally", () => {
    for (let n = 0; n < 3000; n++) {
      const weights = Array.from({ length: int(1, 8) }, () => (rand() < 0.2 ? 0 : int(0, 1_000_000)));
      const total = int(0, 10_000_000);
      const shares = allocateLargestRemainder(total, weights);
      expect(shares).toHaveLength(weights.length);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      const weightSum = weights.reduce((a, b) => a + b, 0);
      shares.forEach((share, i) => {
        expect(Number.isSafeInteger(share) && share >= 0).toBe(true);
        const exact = weightSum === 0 ? total / weights.length : (total * (weights[i] ?? 0)) / weightSum;
        expect(Math.abs(share - exact)).toBeLessThan(1 + 1e-9);
      });
    }
  });
});
