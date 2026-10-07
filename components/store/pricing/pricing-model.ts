/**
 * Pure view model for the Pricing & licensing page: the license matrix, the GST worked example and the numbers the
 * copy quotes (GST rate, one-time update period, maintenance cover). No server imports, so it is unit-tested directly.
 */
import { toIconName } from "@/components/store/active-nav";
import type { IconName } from "@/components/icons/registry";
import { PRICING_MATRIX } from "@/content/pricing";
import type { Tone } from "@/lib/design/tokens";
import { DEFAULT_UPDATES_MONTHS, MAINTENANCE_MONTHS_PER_UNIT } from "@/lib/licensing/terms";
import { PricingError, quote, type PricingPlan, type TaxSettings } from "@/lib/pricing";
import { productHref, startingPlan, unitLabel } from "@/lib/storefront/derive";
import type { PlanType, StorePlan, StoreProduct } from "@/lib/storefront/types";

/** Matrix columns in prototype order (TRIAL ... MAINTENANCE). */
export const PRICING_COLUMN_KEYS = ["trial", "one_time", "annual", "subscription", "multi", "maintenance"] as const;
export type PricingColumnKey = (typeof PRICING_COLUMN_KEYS)[number];

type MatrixPlan = Pick<
  StorePlan,
  "id" | "type" | "pricePaise" | "interval" | "trialDays" | "perUnit" | "multiDevice" | "deviceLimit"
>;

/** Plans that never stand on their own in the multi-device column. */
const NOT_MULTI: ReadonlySet<PlanType> = new Set<PlanType>(["TRIAL", "DEVICE_ADDON", "MAINTENANCE"]);

/**
 * Whether a plan belongs in a column (prototype Pricing renderVals): ONE-TIME leaves out multi-device plans;
 * MULTI-DEVICE takes multi-device or per-unit plans (licenses only, never trials or add-ons).
 */
export function planInColumn(plan: MatrixPlan, key: PricingColumnKey): boolean {
  switch (key) {
    case "trial":
      return plan.type === "TRIAL";
    case "one_time":
      return plan.type === "ONE_TIME" && !plan.multiDevice;
    case "annual":
      return plan.type === "ANNUAL";
    case "subscription":
      return plan.type === "SUBSCRIPTION";
    case "multi":
      return (plan.multiDevice || plan.perUnit !== null) && !NOT_MULTI.has(plan.type);
    case "maintenance":
      return plan.type === "MAINTENANCE";
  }
}

/** Cheapest plan in the list (the first one in plan order on a tie), or null. */
function cheapest<P extends Pick<StorePlan, "pricePaise">>(plans: readonly P[]): P | null {
  let best: P | null = null;
  for (const plan of plans) if (best === null || plan.pricePaise < best.pricePaise) best = plan;
  return best;
}

/**
 * Unit under a matrix price: trials "15 days", per-unit plans "/month per terminal", multi-device plans
 * "up to 5 devices", otherwise "/year", "/month" or "one-time".
 */
export function matrixUnit(plan: MatrixPlan): string {
  if (plan.type === "TRIAL") return unitLabel(plan);
  if (plan.perUnit) return unitLabel(plan, 1);
  if (plan.multiDevice && plan.deviceLimit) return PRICING_MATRIX.upToDevices(plan.deviceLimit);
  return unitLabel(plan);
}

export type MatrixCell =
  | { key: PricingColumnKey; offered: false }
  | { key: PricingColumnKey; offered: true; planId: string; free: boolean; pricePaise: number; unit: string };

/** The starting (cheapest) plan a product offers for one column, or "not offered". */
export function matrixCell(plans: readonly MatrixPlan[], key: PricingColumnKey): MatrixCell {
  const plan = cheapest(plans.filter((p) => planInColumn(p, key)));
  if (!plan) return { key, offered: false };
  return { key, offered: true, planId: plan.id, free: plan.pricePaise === 0, pricePaise: plan.pricePaise, unit: matrixUnit(plan) };
}

export type MatrixRow = {
  id: string;
  name: string;
  icon: IconName;
  tone: Tone;
  /** Product page, scrolled to its plans. */
  href: string;
  cells: MatrixCell[];
};

type MatrixProduct = Pick<StoreProduct, "id" | "shortName" | "icon" | "tone"> & { plans: readonly MatrixPlan[] };

/** One row per product, in the order given (rank). */
export function buildPricingMatrix(products: readonly MatrixProduct[]): MatrixRow[] {
  return products.map((p) => ({
    id: p.id,
    name: p.shortName,
    icon: toIconName(p.icon),
    tone: p.tone,
    href: `${productHref(p.id)}#plans`,
    cells: PRICING_COLUMN_KEYS.map((key) => matrixCell(p.plans, key)),
  }));
}

const SOLD_ALONE: ReadonlySet<PlanType> = new Set<PlanType>(["ONE_TIME", "ANNUAL", "SUBSCRIPTION"]);

/**
 * Plan for the GST worked example: the cheapest ANNUAL plan of the top-ranked product that has one; failing that,
 * the starting plan of the top-ranked product that sells anything. Null when nothing is for sale.
 */
export function gstExamplePlan(products: readonly Pick<StoreProduct, "plans">[]): StorePlan | null {
  for (const p of products) {
    const annual = cheapest(p.plans.filter((plan) => plan.type === "ANNUAL" && plan.pricePaise > 0));
    if (annual) return annual;
  }
  for (const p of products) {
    const start = startingPlan(p);
    if (start && SOLD_ALONE.has(start.type)) return start;
  }
  return null;
}

export type GstExample = {
  planName: string;
  basePaise: number;
  gstPaise: number;
  totalPaise: number;
  ratePct: number;
};

/**
 * Worked example priced by lib/pricing quote() exactly as checkout would: one NEW line, no coupon, billing state
 * unknown (intra-state). Null when no plan qualifies or the plan cannot be quoted.
 */
export function gstExample(
  products: readonly Pick<StoreProduct, "plans">[],
  tax: TaxSettings,
  now: Date = new Date(),
): GstExample | null {
  const plan = gstExamplePlan(products);
  if (!plan) return null;
  const pricing: PricingPlan = {
    id: plan.id,
    productId: plan.productId,
    type: plan.type,
    pricePaise: plan.pricePaise,
    perUnit: plan.perUnit,
    maxQty: plan.maxQty,
  };
  try {
    const q = quote({ lines: [{ planId: plan.id, qty: 1 }], plans: new Map([[plan.id, pricing]]), tax, now });
    return { planName: plan.name, basePaise: q.taxablePaise, gstPaise: q.gstPaise, totalPaise: q.totalPaise, ratePct: q.gstRatePct };
  } catch (error) {
    if (error instanceof PricingError) return null;
    throw error;
  }
}

/**
 * Update period of one-time licenses, from the ONE_TIME plans (a plan without updatesMonths gets the fulfilment
 * default). `varies` is true when plans differ; `months` is then the shortest.
 */
export function oneTimeUpdatePeriod(products: readonly Pick<StoreProduct, "plans">[]): { months: number; varies: boolean } {
  const months = products.flatMap((p) =>
    p.plans.filter((plan) => plan.type === "ONE_TIME").map((plan) => plan.updatesMonths ?? DEFAULT_UPDATES_MONTHS),
  );
  if (months.length === 0) return { months: DEFAULT_UPDATES_MONTHS, varies: false };
  return { months: Math.min(...months), varies: new Set(months).size > 1 };
}

/** Months of cover one maintenance plan adds (fulfilment rule, lib/licensing/terms.ts). */
export const MAINTENANCE_MONTHS = MAINTENANCE_MONTHS_PER_UNIT;

/** "1 month", "12 months". */
export function monthsLabel(months: number): string {
  return months === 1 ? "1 month" : `${months} months`;
}

/** "yearly" for 12 months, otherwise "6-month". */
export function periodAdjective(months: number): string {
  return months === 12 ? "yearly" : `${months}-month`;
}

/** "a year" for 12 months, otherwise "6 months". */
export function periodSpan(months: number): string {
  return months === 12 ? "a year" : monthsLabel(months);
}

const RATE_FORMAT = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

/** A GST rate as the copy prints it: 18 -> "18", 2.5 -> "2.5". */
export function formatRate(ratePct: number): string {
  return RATE_FORMAT.format(ratePct);
}

/** The CGST and SGST share of an intra-state invoice: 18 -> "9". */
export function halfRate(ratePct: number): string {
  return formatRate(ratePct / 2);
}
