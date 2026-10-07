/**
 * Cart and order-summary rows (Cart.dc.html, Checkout.dc.html). Pure and client-safe.
 *
 * Prices always come from the server quote (POST /api/checkout/quote); the plan catalog below only supplies what the
 * quote does not carry (product slug, icon, tone, plan interval and units). While a re-quote is in flight after a
 * quantity change, rows and totals are previewed from the last quote's unit prices with the same GST rule the server
 * uses (decisions.md 3), and replaced as soon as the new quote arrives.
 */
import { toIconName } from "@/components/store/active-nav";
import type { IconName } from "@/components/icons/registry";
import type { CartItem, CartItemKind } from "@/lib/cart/store";
import type { QuoteDto, QuoteIssueDto, QuoteLineDto } from "@/lib/checkout/quote";
import type { Tone } from "@/lib/design/tokens";
import { formatINR } from "@/lib/money";
import { gstSplit } from "@/lib/pricing";
import { productHref, unitLabel } from "@/lib/storefront/derive";
import type { BillingInterval, PlanType, StoreProduct } from "@/lib/storefront/types";

/** What a cart row needs to know about a plan besides its price. */
export type CartPlanInfo = {
  planName: string;
  type: PlanType;
  interval: BillingInterval | null;
  trialDays: number | null;
  deviceLimit: number | null;
  perUnit: string | null;
  maxQty: number | null;
  /** Catalog price excluding GST (only used before the first quote of a line arrives). */
  pricePaise: number;
  productSlug: string;
  productName: string;
  productShortName: string;
  icon: IconName;
  tone: Tone;
};

/** Plan id -> plan details, for every live plan of the published products. Plain JSON (server -> client prop). */
export type CartPlanCatalog = Readonly<Record<string, CartPlanInfo>>;

type CatalogProduct = Pick<StoreProduct, "id" | "name" | "shortName" | "icon" | "tone" | "plans">;

export function toCartPlanCatalog(products: readonly CatalogProduct[]): CartPlanCatalog {
  const catalog: Record<string, CartPlanInfo> = {};
  for (const product of products) {
    for (const plan of product.plans) {
      catalog[plan.id] = {
        planName: plan.name,
        type: plan.type,
        interval: plan.interval,
        trialDays: plan.trialDays,
        deviceLimit: plan.deviceLimit,
        perUnit: plan.perUnit,
        maxQty: plan.maxQty,
        pricePaise: plan.pricePaise,
        productSlug: product.id,
        productName: product.name,
        productShortName: product.shortName,
        icon: toIconName(product.icon),
        tone: product.tone,
      };
    }
  }
  return catalog;
}

/** Same values as the cart store's line key: kind, plan and target license. */
export function lineKeyOf(line: { kind?: string | null; planId: string; targetLicenseId?: string | null }): string {
  return `${line.kind ?? "NEW"}:${line.planId}:${line.targetLicenseId ?? ""}`;
}

/** The body items of a quote or order request, in cart order. */
export type CheckoutRequestItem = { planId: string; qty: number; kind: CartItemKind; targetLicenseId: string | null };

export function toRequestItems(items: readonly CartItem[]): CheckoutRequestItem[] {
  return items.map(({ planId, qty, kind, targetLicenseId }) => ({ planId, qty, kind, targetLicenseId }));
}

const TARGET_PREFIX: Readonly<Record<CartItemKind, string>> = {
  NEW: "For ",
  RENEWAL: "Renewal of ",
  UPGRADE: "Upgrade of ",
  ADDON: "Add-on for ",
};

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 || unit.endsWith("s") ? "" : "s"}`;
}

type UnitPlan = Pick<CartPlanInfo, "type" | "interval" | "trialDays" | "perUnit">;

/** Fallback when the plan is not in the catalog (archived plan of a renewal, hidden product). */
function fallbackUnitPlan(type: PlanType): UnitPlan {
  const yearly = type === "ANNUAL" || type === "MAINTENANCE";
  return { type, interval: yearly ? "YEAR" : null, trialDays: null, perUnit: null };
}

/**
 * Second line of a cart row (prototype `limits`): "3 terminals" for per-unit plans, "N computers" for device add-ons
 * (the quantity is the number of computers added), the plan's device limit otherwise, else "Add-on".
 */
export function limitsLabel(plan: Pick<CartPlanInfo, "type" | "perUnit" | "deviceLimit"> | null, qty: number): string {
  if (plan?.perUnit) return plural(qty, plan.perUnit);
  if (plan?.type === "DEVICE_ADDON") return plural(qty, "computer");
  if (plan?.deviceLimit) return plural(plan.deviceLimit, "computer");
  return "Add-on";
}

/** Third line: "Renewal of LIC-24017 · ₹2,999 /year · excl. GST" or "₹6,999 /year per terminal · excl. GST". */
export function unitLine(args: {
  kind: CartItemKind;
  targetLicenseId: string | null;
  unitPricePaise: number;
  plan: UnitPlan;
}): string {
  const { kind, targetLicenseId, unitPricePaise, plan } = args;
  const target = targetLicenseId ? `${TARGET_PREFIX[kind]}${targetLicenseId} · ` : "";
  const unit = plan.type === "SUBSCRIPTION" && plan.interval === null ? "" : ` ${unitLabel(plan)}`;
  const per = plan.perUnit ? ` per ${plan.perUnit}` : "";
  return `${target}${formatINR(unitPricePaise)}${unit}${per} · excl. GST`;
}

export type CartRowIssue = { code: QuoteIssueDto["code"]; message: string };

export type CartRow = {
  /** The cart line key (cart store). */
  key: string;
  planId: string;
  kind: CartItemKind;
  targetLicenseId: string | null;
  productName: string;
  shortName: string;
  /** Product page, when the product is in the published catalog. */
  href: string | null;
  icon: IconName;
  tone: Tone;
  planName: string;
  qty: number;
  limits: string;
  unitLine: string;
  /** Quantity stepper for per-unit plans (prototype: plan.perUnit, max plan.maxQty || 10). */
  stepper: { max: number; label: string } | null;
  /** Line amount before discount (preview while re-quoting). Null for refused lines. */
  amountPaise: number | null;
  /** "Remove Restaurant Billing Yearly subscription". */
  removeLabel: string;
  /** Set when the server refused the line (shown inline with a remove action). */
  issue: CartRowIssue | null;
};

/**
 * Rows for the cart items, matched to the quote by line key (kind, plan, target license), in cart order. Lines the
 * quote has not seen yet are previewed from the catalog price. Returns null before the first quote (skeleton).
 */
export function buildCartRows(items: readonly CartItem[], quote: QuoteDto | null, catalog: CartPlanCatalog): CartRow[] | null {
  if (!quote) return null;
  const lines = new Map<string, QuoteLineDto>();
  for (const line of quote.lines) lines.set(lineKeyOf(line), line);
  const issues = new Map<string, QuoteIssueDto>();
  for (const issue of quote.issues) issues.set(lineKeyOf(issue), issue);

  return items.map((item): CartRow => {
    const info = catalog[item.planId] ?? null;
    const line = lines.get(item.key) ?? null;
    const issue = line ? null : (issues.get(item.key) ?? null);
    const planType: PlanType = info?.type ?? line?.planType ?? "ONE_TIME";
    const planName = info?.planName ?? line?.planName ?? "Plan";
    const shortName = info?.productShortName ?? line?.productShortName ?? "Item";
    const unitPricePaise = line?.unitPricePaise ?? info?.pricePaise ?? 0;
    const unitPlan: UnitPlan = info ?? fallbackUnitPlan(planType);
    let amountPaise: number | null = null;
    if (line) amountPaise = Math.max(0, line.amountPaise + line.unitPricePaise * (item.qty - line.qty));
    else if (!issue && info) amountPaise = info.pricePaise * item.qty;
    return {
      key: item.key,
      planId: item.planId,
      kind: item.kind,
      targetLicenseId: item.targetLicenseId,
      productName: info?.productName ?? line?.productName ?? shortName,
      shortName,
      href: info ? productHref(info.productSlug) : null,
      icon: info?.icon ?? toIconName(null),
      tone: info?.tone ?? "lavender",
      planName,
      qty: item.qty,
      limits: limitsLabel(info ?? { type: planType, perUnit: null, deviceLimit: null }, item.qty),
      unitLine: unitLine({ kind: item.kind, targetLicenseId: item.targetLicenseId, unitPricePaise, plan: unitPlan }),
      stepper: info?.perUnit
        ? { max: Math.max(1, Math.min(item.maxQty, info.maxQty ?? 10)), label: `Terminals for ${shortName}` }
        : null,
      amountPaise,
      removeLabel: `Remove ${shortName} ${planName}`,
      issue: issue ? { code: issue.code, message: issue.message } : null,
    };
  });
}

export type CartTotals = { subtotalPaise: number; gstPaise: number; totalPaise: number; gstRatePct: number };

/**
 * Cart summary (Subtotal / GST / Estimated total, estimated as intra-state like the prototype). The server values when
 * the quote matches the cart; otherwise a preview from the rows with the server's rule gst = round(taxable * rate).
 */
export function cartTotals(rows: readonly CartRow[], quote: QuoteDto, current: boolean): CartTotals {
  const gstRatePct = quote.gstRatePct;
  if (current) {
    return {
      subtotalPaise: quote.subtotalPaise,
      gstPaise: quote.cgstPaise + quote.sgstPaise + quote.igstPaise,
      totalPaise: quote.totalPaise,
      gstRatePct,
    };
  }
  const subtotalPaise = rows.reduce((sum, row) => sum + (row.amountPaise ?? 0), 0);
  const { gstPaise } = gstSplit(subtotalPaise, gstRatePct, true);
  return { subtotalPaise, gstPaise, totalPaise: subtotalPaise + gstPaise, gstRatePct };
}

/** "18" / "9" / "2.5" for tax labels. */
export function ratePctLabel(ratePct: number): string {
  return Number.isInteger(ratePct) ? String(ratePct) : String(Math.round(ratePct * 100) / 100);
}
