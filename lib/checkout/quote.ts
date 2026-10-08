/**
 * Server-side cart pricing for POST /api/checkout/quote and order creation: loads the pricing context, validates the
 * lines (lines.ts), prices the accepted ones with lib/pricing quote() and maps the result to the API shape.
 * Invalid lines are dropped and reported in `issues`; the coupon is evaluated on the accepted lines only.
 */
import { ItemKind, type PlanType } from "@/generated/prisma/enums";
import type { Db } from "@/lib/db";
import { quote, type Quote } from "@/lib/pricing";
import type { CheckoutItem } from "@/lib/validation/checkout";
import type { PricingBuyer } from "./buyer";
import { validateCheckoutLines, type LineIssue, type ValidLine } from "./lines";
import { loadPricingContext, type PricingContext } from "./pricing-context";

export type QuoteLineDto = {
  planId: string;
  productId: string;
  productName: string;
  productShortName: string;
  planName: string;
  planType: PlanType;
  kind: ItemKind;
  qty: number;
  unitPricePaise: number;
  amountPaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  targetLicenseId: string | null;
  /** "Annual license", "Per-terminal license × 3", "Renewal of LIC-24017", "Upgrade of …", "Add-on for …". */
  label: string;
};

export type QuoteCouponDto =
  | { ok: true; code: string; label: string; discountPaise: number }
  | { ok: false; code: string; message: string }
  | null;

export type QuoteIssueDto = LineIssue;

export type QuoteDto = {
  lines: QuoteLineDto[];
  subtotalPaise: number;
  discountPaise: number;
  taxablePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  gstRatePct: number;
  intraState: boolean;
  companyState: string;
  coupon: QuoteCouponDto;
  issues: QuoteIssueDto[];
};

export type PricedCart = { ctx: PricingContext; lines: ValidLine[]; issues: LineIssue[]; quote: Quote };

export type PriceCartInput = {
  items: readonly CheckoutItem[];
  couponCode?: string | null;
  billingState?: string | null;
  /** An unpaid order being re-priced (Admin > Orders edit): its own coupon slot is not counted as held. */
  excludeOrderId?: string | null;
};

/** Validates and prices a cart from server data only. */
export async function priceCart(db: Db, input: PriceCartInput, buyer: PricingBuyer, now: Date): Promise<PricedCart> {
  const ctx = await loadPricingContext(db, {
    planIds: input.items.map((i) => i.planId),
    couponCode: input.couponCode,
    now,
    excludeOrderId: input.excludeOrderId ?? null,
  });
  const { lines, issues } = await validateCheckoutLines(db, input.items, buyer, ctx, now);
  const priced = quote({
    lines,
    plans: ctx.plans,
    tax: ctx.tax,
    billingState: input.billingState ?? null,
    couponCode: ctx.couponCode,
    coupon: ctx.coupon,
    now,
  });
  return { ctx, lines, issues, quote: priced };
}

const TARGET_PREFIX: Readonly<Record<ItemKind, string>> = {
  [ItemKind.NEW]: "For ",
  [ItemKind.RENEWAL]: "Renewal of ",
  [ItemKind.UPGRADE]: "Upgrade of ",
  [ItemKind.ADDON]: "Add-on for ",
};

/** The cart prototype's line description: the target license for renewals/upgrades/add-ons, else the plan. */
export function lineLabel(kind: ItemKind, planName: string, qty: number, targetLicenseId: string | null): string {
  if (targetLicenseId) return `${TARGET_PREFIX[kind]}${targetLicenseId}`;
  return qty > 1 ? `${planName} × ${qty}` : planName;
}

/** Maps a priced cart to the POST /api/checkout/quote response. */
export function toQuoteDto(priced: PricedCart): QuoteDto {
  const { ctx, quote: q } = priced;
  const lines = q.lines.map((line): QuoteLineDto => {
    const plan = ctx.plans.get(line.planId);
    if (!plan) throw new Error(`Priced line for an unknown plan ${line.planId}`);
    return {
      planId: line.planId,
      productId: line.productId,
      productName: plan.product.name,
      productShortName: plan.product.shortName,
      planName: plan.name,
      planType: line.planType,
      kind: line.kind,
      qty: line.qty,
      unitPricePaise: line.unitPricePaise,
      amountPaise: line.amountPaise,
      discountPaise: line.discountPaise,
      taxablePaise: line.taxablePaise,
      taxPaise: line.taxPaise,
      targetLicenseId: line.targetLicenseId,
      label: lineLabel(line.kind, plan.name, line.qty, line.targetLicenseId),
    };
  });
  const coupon: QuoteCouponDto = q.coupon
    ? q.coupon.ok
      ? { ok: true, code: q.coupon.code, label: q.coupon.label, discountPaise: q.coupon.discountPaise }
      : // The failure reason stays on the server: a paused code must read exactly like an unknown one.
        { ok: false, code: q.coupon.code, message: q.coupon.message }
    : null;
  return {
    lines,
    subtotalPaise: q.subtotalPaise,
    discountPaise: q.discountPaise,
    taxablePaise: q.taxablePaise,
    cgstPaise: q.cgstPaise,
    sgstPaise: q.sgstPaise,
    igstPaise: q.igstPaise,
    totalPaise: q.totalPaise,
    gstRatePct: q.gstRatePct,
    intraState: q.intraState,
    companyState: ctx.tax.companyState,
    coupon,
    issues: priced.issues,
  };
}
