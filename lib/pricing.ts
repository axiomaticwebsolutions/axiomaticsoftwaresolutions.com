import { CouponType, ItemKind, PlanType } from "@/generated/prisma/enums";
import { formatDateIST } from "@/lib/dates";
import { assertPaise, formatINR } from "@/lib/money";

/**
 * Pure cart pricing: line amounts, coupons, GST (docs/decisions.md section 3) and largest-remainder
 * allocation so line items always sum to the order header. No DB, no env: the server re-prices every
 * cart with this module, and the client may use it for previews.
 */

export type PricingPlan = {
  id: string;
  productId: string;
  type: PlanType;
  pricePaise: number;
  perUnit: string | null;
  maxQty: number | null;
  archived?: boolean;
};

export type CartLine = {
  planId: string;
  qty: number;
  kind?: ItemKind;
  targetLicenseId?: string | null;
  /** Upgrade credit. Server-supplied only; never taken from client input. */
  creditPaise?: number;
};

export type CouponRule = {
  code: string;
  type: CouponType;
  /** Percent for PERCENT, paise for FLAT. */
  value: number;
  label: string;
  /** Paise, compared with the whole cart subtotal. */
  minSubtotal: number | null;
  /** Empty = all products. */
  productIds: string[];
  /** Empty = all plan types. */
  planTypes: PlanType[];
  startsAt: Date;
  endsAt: Date;
  maxRedemptions: number | null;
  redemptions: number;
  active: boolean;
};

export type TaxSettings = { gstRatePct: number; companyState: string };

export type CouponFailure =
  | "not_found"
  | "paused"
  | "not_started"
  | "expired"
  | "limit_reached"
  | "not_applicable"
  | "min_subtotal";

export type CouponOutcome =
  | { ok: true; code: string; label: string; discountPaise: number }
  | { ok: false; code: string; reason: CouponFailure; message: string };

export type QuoteLine = {
  planId: string;
  productId: string;
  planType: PlanType;
  kind: ItemKind;
  qty: number;
  unitPricePaise: number;
  /** unitPricePaise * qty - creditPaise. */
  amountPaise: number;
  /** Effective credit (capped at unitPricePaise * qty). */
  creditPaise: number;
  discountPaise: number;
  /** amountPaise - discountPaise. */
  taxablePaise: number;
  taxPaise: number;
  targetLicenseId: string | null;
};

export type Quote = {
  lines: QuoteLine[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  gstPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  gstRatePct: number;
  intraState: boolean;
  placeOfSupply: string | null;
  coupon: CouponOutcome | null;
};

export type PricingErrorCode =
  | "unknown_plan"
  | "archived_plan"
  | "trial_not_purchasable"
  | "invalid_item_kind"
  | "invalid_quantity"
  | "target_required";

const PRICING_ERROR_MESSAGES: Record<PricingErrorCode, string> = {
  unknown_plan: "This plan doesn’t exist.",
  archived_plan: "This plan is no longer available.",
  trial_not_purchasable: "Free trials are started from your account, not bought.",
  invalid_item_kind: "This plan can’t be bought that way.",
  invalid_quantity: "Quantity must be a whole number of at least 1.",
  target_required: "Choose the license this item applies to.",
};

/** A cart line that cannot be priced. API handlers map this to a 422 for the offending plan. */
export class PricingError extends Error {
  readonly code: PricingErrorCode;
  readonly planId: string;

  constructor(code: PricingErrorCode, planId: string, message: string = PRICING_ERROR_MESSAGES[code]) {
    super(message);
    this.name = "PricingError";
    this.code = code;
    this.planId = planId;
  }
}

/**
 * Plan types each item kind can be sold with: exactly the pairs fulfilment (lib/licensing/fulfil.ts, terms.ts) can
 * carry out, so a quote never prices an order that would go to REVIEW after payment. RENEWAL of a ONE_TIME plan is
 * absent because perpetual licenses renew through MAINTENANCE; TRIAL plans are never sold.
 */
export const ITEM_KIND_PLAN_TYPES: Readonly<Record<ItemKind, readonly PlanType[]>> = Object.freeze({
  [ItemKind.NEW]: [PlanType.ONE_TIME, PlanType.ANNUAL, PlanType.SUBSCRIPTION],
  [ItemKind.RENEWAL]: [PlanType.ANNUAL, PlanType.SUBSCRIPTION, PlanType.MAINTENANCE],
  [ItemKind.ADDON]: [PlanType.DEVICE_ADDON],
  [ItemKind.UPGRADE]: [PlanType.ONE_TIME, PlanType.ANNUAL, PlanType.SUBSCRIPTION],
});

/** True when an item of `kind` can be sold with a plan of `planType` (see ITEM_KIND_PLAN_TYPES). */
export function isItemKindAllowed(kind: ItemKind, planType: PlanType): boolean {
  return ITEM_KIND_PLAN_TYPES[kind].includes(planType);
}

/** Quantity cap for per-unit plans and device add-ons whose plan has no maxQty. */
export const DEFAULT_MAX_QTY = 10;

/** Coupon copy (prototype checkCoupon), curly apostrophes included. */
export const COUPON_MESSAGES = {
  invalid: "This code isn’t valid. Check the spelling and try again.",
  limitReached: "This code has reached its usage limit.",
  notApplicable: "This code doesn’t apply to the items in your cart.",
  startsOn: (startsAt: Date) => `This code starts on ${formatDateIST(startsAt)}.`,
  expiredOn: (endsAt: Date) => `This code expired on ${formatDateIST(endsAt)}.`,
  addMore: (shortfallPaise: number) => `Add ${formatINR(shortfallPaise)} more to use this code.`,
} as const;

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Server-side quantity rules. Single-seat plans (non-per-unit ONE_TIME/ANNUAL/SUBSCRIPTION) are
 * always 1, whatever the kind; per-unit plans and device add-ons clamp to 1..(maxQty ?? 10);
 * maintenance is 1. Non-integers and values below 1 are rejected rather than rounded.
 */
export function normalizeQuantity(plan: PricingPlan, kind: ItemKind, qty: number): number {
  if (!Number.isSafeInteger(qty) || qty < 1) {
    throw new PricingError("invalid_quantity", plan.id);
  }
  if (plan.type === PlanType.MAINTENANCE) return 1;
  if (plan.type === PlanType.DEVICE_ADDON || plan.perUnit) {
    return Math.min(qty, Math.max(1, plan.maxQty ?? DEFAULT_MAX_QTY));
  }
  return 1;
}

/**
 * Splits `total` into integer shares proportional to `weights` that sum exactly to `total`.
 * Each index gets floor(total * w / sum); the leftover units go to the largest remainders,
 * ties to the earlier index. All-zero weights spread `total` evenly, extra units from index 0.
 * Exact for any safe-integer inputs (BigInt intermediate products).
 */
export function allocateLargestRemainder(total: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new RangeError(`allocateLargestRemainder: total must be a non-negative integer, got ${total}`);
  }
  for (const w of weights) {
    if (!Number.isSafeInteger(w) || w < 0) {
      throw new RangeError(`allocateLargestRemainder: weights must be non-negative integers, got ${w}`);
    }
  }
  const n = weights.length;
  if (n === 0) {
    if (total === 0) return [];
    throw new RangeError("allocateLargestRemainder: cannot allocate a non-zero total over no weights");
  }

  const bigTotal = BigInt(total);
  const sum = weights.reduce((acc, w) => acc + BigInt(w), 0n);
  if (sum === 0n) {
    const base = Math.floor(total / n);
    const extra = total - base * n;
    return weights.map((_, i) => base + (i < extra ? 1 : 0));
  }

  const parts = weights.map((w, index) => {
    const product = bigTotal * BigInt(w);
    return { index, share: Number(product / sum), remainder: product % sum };
  });
  let leftover = total - parts.reduce((acc, p) => acc + p.share, 0);
  const byRemainder = [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const part of byRemainder) {
    if (leftover <= 0) break;
    part.share += 1;
    leftover -= 1;
  }
  return parts.map((p) => p.share);
}

function assertRate(ratePct: number): void {
  if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct > 100) {
    throw new RangeError(`GST rate must be between 0 and 100, got ${ratePct}`);
  }
}

/**
 * GST on the order taxable value: gst = round(taxable * rate / 100). Intra-state splits it into
 * CGST = round(gst / 2) and SGST = gst - CGST; inter-state charges it all as IGST.
 */
export function gstSplit(
  taxablePaise: number,
  ratePct: number,
  intraState: boolean,
): { gstPaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number } {
  assertPaise(taxablePaise);
  if (taxablePaise < 0) throw new RangeError(`Taxable value cannot be negative, got ${taxablePaise}`);
  assertRate(ratePct);
  const gstPaise = Math.round((taxablePaise * ratePct) / 100);
  if (!intraState) return { gstPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: gstPaise };
  const cgstPaise = Math.round(gstPaise / 2);
  return { gstPaise, cgstPaise, sgstPaise: gstPaise - cgstPaise, igstPaise: 0 };
}

function hasTarget(line: CartLine): line is CartLine & { targetLicenseId: string } {
  return typeof line.targetLicenseId === "string" && line.targetLicenseId.trim() !== "";
}

/**
 * Validates one cart line against its plan and returns it priced, before discount and tax. Archived plans can't be
 * bought, but existing licenses keep renewing on them (Admin Console archive dialog), so RENEWAL lines pass.
 * Whether the target license exists, belongs to the buyer and matches the plan's product is the checkout's check.
 */
function priceLine(line: CartLine, plans: ReadonlyMap<string, PricingPlan>): QuoteLine {
  const plan = plans.get(line.planId);
  if (!plan) throw new PricingError("unknown_plan", line.planId);
  if (plan.type === PlanType.TRIAL) throw new PricingError("trial_not_purchasable", plan.id);

  const kind = line.kind ?? ItemKind.NEW;
  if (!isItemKindAllowed(kind, plan.type)) throw new PricingError("invalid_item_kind", plan.id);
  if (plan.archived && kind !== ItemKind.RENEWAL) throw new PricingError("archived_plan", plan.id);
  const needsTarget =
    kind !== ItemKind.NEW || plan.type === PlanType.DEVICE_ADDON || plan.type === PlanType.MAINTENANCE;
  if (needsTarget && !hasTarget(line)) throw new PricingError("target_required", plan.id);

  const qty = normalizeQuantity(plan, kind, line.qty);
  assertPaise(plan.pricePaise);
  if (plan.pricePaise < 0) throw new RangeError(`Plan ${plan.id} has a negative price`);
  const credit = line.creditPaise ?? 0;
  if (!Number.isSafeInteger(credit) || credit < 0) {
    throw new RangeError(`creditPaise must be a non-negative integer, got ${credit}`);
  }

  const gross = plan.pricePaise * qty;
  const creditPaise = Math.min(credit, gross);
  const amountPaise = gross - creditPaise;
  return {
    planId: plan.id,
    productId: plan.productId,
    planType: plan.type,
    kind,
    qty,
    unitPricePaise: plan.pricePaise,
    amountPaise,
    creditPaise,
    discountPaise: 0,
    taxablePaise: amountPaise,
    taxPaise: 0,
    // A target only means something for renewals, upgrades and add-ons; drop stray ones on NEW lines.
    targetLicenseId: needsTarget && hasTarget(line) ? line.targetLicenseId : null,
  };
}

function isEligible(coupon: CouponRule, line: QuoteLine): boolean {
  return (
    (coupon.productIds.length === 0 || coupon.productIds.includes(line.productId)) &&
    (coupon.planTypes.length === 0 || coupon.planTypes.includes(line.planType))
  );
}

type AppliedCoupon = { outcome: CouponOutcome; eligible: readonly boolean[] };

/** Coupon rules in the documented order, against already-priced lines. */
function applyCoupon(rawCode: string, coupon: CouponRule | null, lines: readonly QuoteLine[], now: Date): AppliedCoupon {
  const code = normalizeCouponCode(rawCode);
  const fail = (reason: CouponFailure, message: string): AppliedCoupon => ({
    outcome: { ok: false, code, reason, message },
    eligible: lines.map(() => false),
  });

  if (!coupon || code === "" || normalizeCouponCode(coupon.code) !== code) {
    return fail("not_found", COUPON_MESSAGES.invalid);
  }
  // A paused code reads exactly like an unknown one, so codes cannot be probed.
  if (!coupon.active) return fail("paused", COUPON_MESSAGES.invalid);
  const t = now.getTime();
  if (t < coupon.startsAt.getTime()) return fail("not_started", COUPON_MESSAGES.startsOn(coupon.startsAt));
  if (t > coupon.endsAt.getTime()) return fail("expired", COUPON_MESSAGES.expiredOn(coupon.endsAt));
  if (coupon.maxRedemptions !== null && coupon.redemptions >= coupon.maxRedemptions) {
    return fail("limit_reached", COUPON_MESSAGES.limitReached);
  }

  const eligible = lines.map((line) => isEligible(coupon, line));
  if (!eligible.some(Boolean)) return fail("not_applicable", COUPON_MESSAGES.notApplicable);

  const subtotal = lines.reduce((acc, line) => acc + line.amountPaise, 0);
  if (coupon.minSubtotal !== null && subtotal < coupon.minSubtotal) {
    return fail("min_subtotal", COUPON_MESSAGES.addMore(coupon.minSubtotal - subtotal));
  }

  const base = lines.reduce((acc, line, i) => acc + (eligible[i] ? line.amountPaise : 0), 0);
  const raw = coupon.type === CouponType.PERCENT ? Math.round((base * coupon.value) / 100) : coupon.value;
  const discountPaise = Math.max(0, Math.min(base, raw));
  return { outcome: { ok: true, code, label: coupon.label, discountPaise }, eligible };
}

/**
 * Checks `code` against `coupon` (the row looked up by the normalised code, or null) for this cart.
 * Lines are validated and normalised exactly as quote() does, so both agree on the discount.
 */
export function evaluateCoupon(args: {
  code: string;
  coupon: CouponRule | null;
  lines: readonly CartLine[];
  plans: ReadonlyMap<string, PricingPlan>;
  now: Date;
}): CouponOutcome {
  const lines = args.lines.map((line) => priceLine(line, args.plans));
  return applyCoupon(args.code, args.coupon, lines, args.now).outcome;
}

/**
 * Prices a cart. Throws PricingError for unknown/trial plans, archived plans (except renewals), item kinds the plan
 * type can't be sold as, bad quantities and renewal/upgrade/add-on/maintenance lines without a target license. A blank or missing
 * couponCode means no coupon (coupon: null); an invalid one yields { ok: false } and no discount.
 *
 * Invariants: sum(line.discountPaise) = discountPaise, sum(line.taxablePaise) = taxablePaise,
 * sum(line.taxPaise) = gstPaise, cgst + sgst + igst = gstPaise, totalPaise = taxablePaise + gstPaise.
 */
export function quote(args: {
  lines: readonly CartLine[];
  plans: ReadonlyMap<string, PricingPlan>;
  tax: TaxSettings;
  billingState?: string | null;
  couponCode?: string | null;
  coupon?: CouponRule | null;
  now: Date;
}): Quote {
  const { tax } = args;
  assertRate(tax.gstRatePct);
  const lines = args.lines.map((line) => priceLine(line, args.plans));
  const subtotalPaise = lines.reduce((acc, line) => acc + line.amountPaise, 0);

  let coupon: CouponOutcome | null = null;
  let discountPaise = 0;
  const code = args.couponCode == null ? "" : normalizeCouponCode(args.couponCode);
  if (code !== "") {
    const applied = applyCoupon(code, args.coupon ?? null, lines, args.now);
    coupon = applied.outcome;
    if (applied.outcome.ok) {
      discountPaise = applied.outcome.discountPaise;
      const weights = lines.map((line, i) => (applied.eligible[i] ? line.amountPaise : 0));
      const shares = allocateLargestRemainder(discountPaise, weights);
      lines.forEach((line, i) => {
        line.discountPaise = shares[i] ?? 0;
        line.taxablePaise = line.amountPaise - line.discountPaise;
      });
    }
  }

  const taxablePaise = subtotalPaise - discountPaise;
  // Unknown billing state is treated as intra-state, as in the prototype.
  const billingState = args.billingState ? args.billingState : null;
  const intraState = billingState === null || billingState === tax.companyState;
  const split = gstSplit(taxablePaise, tax.gstRatePct, intraState);
  const taxShares = allocateLargestRemainder(
    split.gstPaise,
    lines.map((line) => line.taxablePaise),
  );
  lines.forEach((line, i) => {
    line.taxPaise = taxShares[i] ?? 0;
  });

  return {
    lines,
    subtotalPaise,
    discountPaise,
    taxablePaise,
    gstPaise: split.gstPaise,
    cgstPaise: split.cgstPaise,
    sgstPaise: split.sgstPaise,
    igstPaise: split.igstPaise,
    totalPaise: taxablePaise + split.gstPaise,
    gstRatePct: tax.gstRatePct,
    intraState,
    placeOfSupply: billingState,
    coupon,
  };
}
