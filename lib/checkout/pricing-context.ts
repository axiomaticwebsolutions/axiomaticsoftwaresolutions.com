/**
 * Server-side inputs for lib/pricing quote(): the plans named in the cart (with their product), the coupon row for
 * the code and the tax settings (GST rate, company state). Everything comes from the database; prices, coupon
 * values and tax rates are never taken from the client.
 */
import type { BillingInterval, PublishStatus } from "@/generated/prisma/enums";
import { getSettings, taxSettingsForPricing, type SiteSettings } from "@/lib/config";
import type { Db } from "@/lib/db";
import { normalizeCouponCode, type CouponRule, type PricingPlan, type TaxSettings } from "@/lib/pricing";
import type { TermPlan } from "@/lib/licensing/terms";
import { heldCouponSlots } from "./coupon-hold";

/** A plan as checkout sees it: pricing fields, term fields (target checks) and its product. */
export type CheckoutPlan = PricingPlan &
  TermPlan & {
    name: string;
    interval: BillingInterval | null;
    product: { id: string; code: string; name: string; shortName: string; status: PublishStatus };
  };

export type PricingContext = {
  plans: ReadonlyMap<string, CheckoutPlan>;
  tax: TaxSettings;
  /** The coupon row for `couponCode`, or null (unknown code or no code). */
  coupon: CouponRule | null;
  /** Normalised code as entered, or null when none was given. */
  couponCode: string | null;
  settings: Pick<SiteSettings, "business" | "tax">;
};

const planSelect = {
  id: true,
  productId: true,
  type: true,
  name: true,
  pricePaise: true,
  interval: true,
  trialDays: true,
  deviceLimit: true,
  perUnit: true,
  maxQty: true,
  updatesMonths: true,
  archived: true,
  product: { select: { id: true, code: true, name: true, shortName: true, status: true } },
} as const;

/**
 * Loads the plans in `planIds` (unknown ids are simply absent), the coupon for `couponCode` and the tax settings.
 * With `now`, a limited coupon's `redemptions` also counts the slots unpaid orders hold (lib/checkout/coupon-hold.ts),
 * so the quote says "usage limit" exactly when order creation would refuse the code.
 */
export async function loadPricingContext(
  db: Db,
  input: { planIds: readonly string[]; couponCode?: string | null; now?: Date },
): Promise<PricingContext> {
  const ids = [...new Set(input.planIds)];
  const code = input.couponCode ? normalizeCouponCode(input.couponCode) : "";
  const [planRows, couponRow, settings] = await Promise.all([
    ids.length > 0 ? db.plan.findMany({ where: { id: { in: ids } }, select: planSelect }) : Promise.resolve([]),
    code !== "" ? db.coupon.findUnique({ where: { code } }) : Promise.resolve(null),
    getSettings(db),
  ]);

  const plans = new Map<string, CheckoutPlan>();
  for (const row of planRows) plans.set(row.id, { ...row, product: { ...row.product } });

  const held =
    couponRow && couponRow.maxRedemptions !== null && input.now ? await heldCouponSlots(db, couponRow.code, { now: input.now }) : 0;
  const coupon: CouponRule | null = couponRow
    ? {
        code: couponRow.code,
        type: couponRow.type,
        value: couponRow.value,
        label: couponRow.label,
        minSubtotal: couponRow.minSubtotal,
        productIds: [...couponRow.productIds],
        planTypes: [...couponRow.planTypes],
        startsAt: couponRow.startsAt,
        endsAt: couponRow.endsAt,
        maxRedemptions: couponRow.maxRedemptions,
        redemptions: couponRow.redemptions + held,
        active: couponRow.active,
      }
    : null;

  return {
    plans,
    tax: taxSettingsForPricing(settings),
    coupon,
    couponCode: code === "" ? null : code,
    settings: { business: settings.business, tax: settings.tax },
  };
}
