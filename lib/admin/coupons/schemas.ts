/**
 * Request bodies of the coupon admin API (strict Zod; 422 validation_failed with field errors) and the cross-field
 * rules checked after a patch is merged into the stored coupon. Pure and client-safe.
 */
import { z } from "zod";
import {
  COUPON_CODE_RE,
  COUPON_FLAT_MAX_PAISE,
  COUPON_LABEL_MAX,
  COUPON_MAX_REDEMPTIONS_MAX,
  COUPON_MIN_SUBTOTAL_MAX_PAISE,
  COUPON_PERCENT_MAX,
  COUPON_PLAN_TYPES,
  type CouponPlanType,
} from "./model";

export const COUPON_ERRORS = {
  code: "Use 3 to 40 letters, digits or hyphens.",
  codeTaken: "A coupon with this code already exists.",
  type: "Choose percent off or amount off.",
  percent: "Enter a whole percentage from 1 to 100.",
  flat: "Enter an amount from \u20b91 to \u20b91,00,000.",
  label: `Describe the offer for the checkout page (3 to ${COUPON_LABEL_MAX} characters).`,
  minSubtotal: "Enter an amount up to \u20b910,00,000, or leave it empty.",
  date: "Enter a valid date.",
  endsBeforeStart: "The end date can\u2019t be before the start date.",
  maxRedemptions: "Enter a whole number from 1 to 10,00,000, or leave it empty.",
  belowUsed: (n: number) =>
    `This code has been used ${n.toLocaleString("en-IN")} ${n === 1 ? "time" : "times"}. Set a limit of at least ${n.toLocaleString("en-IN")}, or pause it instead.`,
  products: "Choose products from the list.",
  planTypes: "Choose plan types from the list.",
  nothingToSave: "Change a field before saving.",
  value: "Enter the discount as a whole number.",
} as const;

/** "YYYY-MM-DD" that is a real calendar date. */
export function isCalendarDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return false;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

const dateField = z.string({ error: COUPON_ERRORS.date }).max(10, COUPON_ERRORS.date).refine(isCalendarDate, COUPON_ERRORS.date);
const idList = z.array(z.string().trim().min(1).max(80), { error: COUPON_ERRORS.products }).max(50, COUPON_ERRORS.products);
const planTypeList = z.array(z.enum(COUPON_PLAN_TYPES, { error: COUPON_ERRORS.planTypes }), { error: COUPON_ERRORS.planTypes }).max(
  COUPON_PLAN_TYPES.length,
  COUPON_ERRORS.planTypes,
);

const editableShape = {
  type: z.enum(["PERCENT", "FLAT"], { error: COUPON_ERRORS.type }),
  /** Percent (PERCENT) or paise (FLAT); the range is checked with the type. */
  value: z.number({ error: COUPON_ERRORS.value }).int(COUPON_ERRORS.value).positive(COUPON_ERRORS.value),
  label: z.string({ error: COUPON_ERRORS.label }).trim().min(3, COUPON_ERRORS.label).max(COUPON_LABEL_MAX, COUPON_ERRORS.label),
  /** Paise; null = no minimum. */
  minSubtotal: z
    .number({ error: COUPON_ERRORS.minSubtotal })
    .int(COUPON_ERRORS.minSubtotal)
    .min(1, COUPON_ERRORS.minSubtotal)
    .max(COUPON_MIN_SUBTOTAL_MAX_PAISE, COUPON_ERRORS.minSubtotal)
    .nullable(),
  /** Empty = every product. */
  productIds: idList,
  /** Empty = every plan type. */
  planTypes: planTypeList,
  /** IST calendar days: from 00:00 of startsOn to 23:59:59.999 of endsOn. */
  startsOn: dateField,
  endsOn: dateField,
  /** null = no limit. */
  maxRedemptions: z
    .number({ error: COUPON_ERRORS.maxRedemptions })
    .int(COUPON_ERRORS.maxRedemptions)
    .min(1, COUPON_ERRORS.maxRedemptions)
    .max(COUPON_MAX_REDEMPTIONS_MAX, COUPON_ERRORS.maxRedemptions)
    .nullable(),
};

/** POST /api/admin/coupons. New coupons start paused. */
export const couponCreateSchema = z.strictObject({
  code: z.string({ error: COUPON_ERRORS.code }).trim().toUpperCase().regex(COUPON_CODE_RE, COUPON_ERRORS.code),
  ...editableShape,
  minSubtotal: editableShape.minSubtotal.optional().transform((v) => v ?? null),
  productIds: idList.optional().transform((v) => v ?? []),
  planTypes: planTypeList.optional().transform((v) => v ?? []),
  maxRedemptions: editableShape.maxRedemptions.optional().transform((v) => v ?? null),
});
export type CouponCreateInput = z.output<typeof couponCreateSchema>;

/** PATCH /api/admin/coupons/:code (the code never changes: orders and redemptions keep it). */
export const couponUpdateSchema = z.strictObject({
  type: editableShape.type.optional(),
  value: editableShape.value.optional(),
  label: editableShape.label.optional(),
  minSubtotal: editableShape.minSubtotal.optional(),
  productIds: idList.optional(),
  planTypes: planTypeList.optional(),
  startsOn: dateField.optional(),
  endsOn: dateField.optional(),
  maxRedemptions: editableShape.maxRedemptions.optional(),
});
export type CouponUpdateInput = z.output<typeof couponUpdateSchema>;

/** The editable rules after a patch is merged into the stored coupon. */
export type CouponRules = {
  type: "PERCENT" | "FLAT";
  value: number;
  startsOn: string;
  endsOn: string;
  maxRedemptions: number | null;
  productIds: readonly string[];
  planTypes: readonly CouponPlanType[];
};

/**
 * Cross-field rules: the value range for the type, end on or after start, a limit no lower than the redemptions so
 * far, known products. Returns field errors (empty when valid).
 */
export function couponRuleErrors(
  rules: CouponRules,
  ctx: { redemptions: number; knownProductIds: ReadonlySet<string> },
): Record<string, string> {
  const errors: Record<string, string> = {};
  if (rules.type === "PERCENT" && (rules.value < 1 || rules.value > COUPON_PERCENT_MAX)) errors.value = COUPON_ERRORS.percent;
  if (rules.type === "FLAT" && (rules.value < 100 || rules.value > COUPON_FLAT_MAX_PAISE)) errors.value = COUPON_ERRORS.flat;
  if (rules.endsOn < rules.startsOn) errors.endsOn = COUPON_ERRORS.endsBeforeStart;
  if (rules.maxRedemptions !== null && rules.maxRedemptions < ctx.redemptions) {
    errors.maxRedemptions = COUPON_ERRORS.belowUsed(ctx.redemptions);
  }
  if (rules.productIds.some((id) => !ctx.knownProductIds.has(id))) errors.productIds = COUPON_ERRORS.products;
  return errors;
}
