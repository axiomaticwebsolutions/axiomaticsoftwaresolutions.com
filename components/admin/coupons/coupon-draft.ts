/**
 * The coupon editor's form state and its conversion to the API bodies (POST /api/admin/coupons, PATCH
 * /api/admin/coupons/:code). Rupee amounts are typed in rupees and sent in paise; empty optional fields mean "none".
 * Pure.
 */
import type { CouponType } from "@/generated/prisma/enums";
import { COUPON_ERRORS } from "@/lib/admin/coupons/schemas";
import { normalizeCouponCode, type CouponDto, type CouponPlanType } from "@/lib/admin/coupons/model";

export type CouponDraft = {
  code: string;
  type: CouponType;
  value: string;
  label: string;
  minSubtotal: string;
  productIds: string[];
  planTypes: CouponPlanType[];
  startsOn: string;
  endsOn: string;
  maxRedemptions: string;
};

export type CouponBody = {
  code?: string;
  type: CouponType;
  value: number;
  label: string;
  minSubtotal: number | null;
  productIds: string[];
  planTypes: CouponPlanType[];
  startsOn: string;
  endsOn: string;
  maxRedemptions: number | null;
};

function rupees(paise: number | null): string {
  if (paise === null) return "";
  return paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2);
}

/** "2026-10-07" + days, as an IST calendar date string (date-only arithmetic in UTC). */
export function addDaysToDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y ?? 2026, (m ?? 1) - 1, d ?? 1) + days * 86_400_000);
  return t.toISOString().slice(0, 10);
}

/** Editor state for a stored coupon, or the defaults of a new one (10% off for 30 days from `today`, limit 100). */
export function couponDraft(coupon: CouponDto | null, today: string): CouponDraft {
  if (!coupon) {
    return {
      code: "",
      type: "PERCENT",
      value: "10",
      label: "",
      minSubtotal: "",
      productIds: [],
      planTypes: [],
      startsOn: today,
      endsOn: addDaysToDate(today, 30),
      maxRedemptions: "100",
    };
  }
  return {
    code: coupon.code,
    type: coupon.type,
    value: coupon.type === "PERCENT" ? String(coupon.value) : rupees(coupon.value),
    label: coupon.label,
    minSubtotal: rupees(coupon.minSubtotal),
    productIds: [...coupon.productIds],
    planTypes: coupon.planTypes.filter((t): t is CouponPlanType => t !== "TRIAL"),
    startsOn: coupon.startsOn,
    endsOn: coupon.endsOn,
    maxRedemptions: coupon.maxRedemptions === null ? "" : String(coupon.maxRedemptions),
  };
}

const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;
const WHOLE_RE = /^\d{1,9}$/;

function paiseOf(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  return AMOUNT_RE.test(t) ? Math.round(Number(t) * 100) : null;
}

/** The body, or field errors for values that are not numbers (ranges are checked by the server). */
export function couponBody(draft: CouponDraft): { body: CouponBody; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const valueText = draft.value.trim().replace(/,/g, "");
  let value = 0;
  if (draft.type === "PERCENT") {
    if (WHOLE_RE.test(valueText)) value = Number(valueText);
    else errors.value = COUPON_ERRORS.percent;
  } else {
    const paise = paiseOf(valueText);
    if (paise === null) errors.value = COUPON_ERRORS.flat;
    else value = paise;
  }
  let minSubtotal: number | null = null;
  if (draft.minSubtotal.trim() !== "") {
    minSubtotal = paiseOf(draft.minSubtotal);
    if (minSubtotal === null) errors.minSubtotal = COUPON_ERRORS.minSubtotal;
  }
  let maxRedemptions: number | null = null;
  const limitText = draft.maxRedemptions.trim().replace(/,/g, "");
  if (limitText !== "") {
    if (WHOLE_RE.test(limitText)) maxRedemptions = Number(limitText);
    else errors.maxRedemptions = COUPON_ERRORS.maxRedemptions;
  }
  return {
    body: {
      code: normalizeCouponCode(draft.code),
      type: draft.type,
      value,
      label: draft.label.trim(),
      minSubtotal,
      productIds: draft.productIds,
      planTypes: draft.planTypes,
      startsOn: draft.startsOn,
      endsOn: draft.endsOn,
      maxRedemptions,
    },
    errors,
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** The PATCH body: only what differs from the stored coupon (empty object when nothing changed). */
export function couponPatch(coupon: CouponDto, body: CouponBody): Partial<CouponBody> {
  const patch: Partial<CouponBody> = {};
  if (body.type !== coupon.type) patch.type = body.type;
  if (body.value !== coupon.value || body.type !== coupon.type) patch.value = body.value;
  if (body.label !== coupon.label) patch.label = body.label;
  if (body.minSubtotal !== coupon.minSubtotal) patch.minSubtotal = body.minSubtotal;
  if (!sameSet(body.productIds, coupon.productIds)) patch.productIds = body.productIds;
  if (!sameSet(body.planTypes, coupon.planTypes)) patch.planTypes = body.planTypes;
  if (body.startsOn !== coupon.startsOn) patch.startsOn = body.startsOn;
  if (body.endsOn !== coupon.endsOn) patch.endsOn = body.endsOn;
  if (body.maxRedemptions !== coupon.maxRedemptions) patch.maxRedemptions = body.maxRedemptions;
  return patch;
}
