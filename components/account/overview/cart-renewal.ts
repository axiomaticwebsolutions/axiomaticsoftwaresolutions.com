/**
 * "Renew" / "Renew now" / "Buy a license" from the portal (prototype addRenewal): puts the license's renewal line in
 * the cart, replacing lines the checkout would refuse next to it (lib/checkout/lines.ts "duplicate_target": one line
 * per kind per license, and an UPGRADE alone), then the caller opens /cart. Device add-on lines for the license stay
 * next to a RENEWAL. The server re-prices and re-checks everything at checkout. Pure and client-safe.
 */
import type { AddToCartResult, CartItem, CartStore } from "@/lib/cart/store";
import type { RenewalOption } from "@/lib/licensing/account";

/** Quantity cap for per-unit renewal lines in the cart stepper (lib/pricing DEFAULT_MAX_QTY; the plan may set less). */
export const RENEWAL_LINE_MAX_QTY = 10;

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export type RenewalCartLine = {
  planId: string;
  qty: number;
  maxQty: number;
  kind: "RENEWAL" | "UPGRADE";
  targetLicenseId: string;
};

/** The cart line for a renewal option (RENEWAL or MAINTENANCE -> RENEWAL, a trial's BUY -> UPGRADE), or null. */
export function renewalCartLine(licenseId: string, renewal: Pick<RenewalOption, "kind" | "planId" | "qty">): RenewalCartLine | null {
  if (renewal.kind !== "RENEWAL" && renewal.kind !== "UPGRADE") return null;
  if (!ID_RE.test(licenseId) || !ID_RE.test(renewal.planId)) return null;
  const qty = Number.isInteger(renewal.qty) && renewal.qty >= 1 ? renewal.qty : 1;
  return {
    planId: renewal.planId,
    qty,
    maxQty: Math.max(qty, RENEWAL_LINE_MAX_QTY),
    kind: renewal.kind,
    targetLicenseId: licenseId,
  };
}

/** Cart lines that cannot stay next to `line` (same license: same kind, any UPGRADE, or anything next to an UPGRADE). */
export function conflictingLines(items: readonly CartItem[], line: Pick<RenewalCartLine, "kind" | "targetLicenseId">): CartItem[] {
  return items.filter(
    (item) =>
      item.targetLicenseId === line.targetLicenseId &&
      (line.kind === "UPGRADE" || item.kind === line.kind || item.kind === "UPGRADE"),
  );
}

export type RenewalCartResult = AddToCartResult | { ok: false; reason: "unsupported" };

/** Replaces the license's conflicting lines with its renewal line. */
export function addRenewalToCart(
  store: Pick<CartStore, "getSnapshot" | "add" | "remove">,
  licenseId: string,
  renewal: Pick<RenewalOption, "kind" | "planId" | "qty">,
): RenewalCartResult {
  const line = renewalCartLine(licenseId, renewal);
  if (!line) return { ok: false, reason: "unsupported" };
  for (const item of conflictingLines(store.getSnapshot().items, line)) store.remove(item.key);
  return store.add(line.planId, {
    qty: line.qty,
    maxQty: line.maxQty,
    kind: line.kind,
    targetLicenseId: line.targetLicenseId,
  });
}

export const CART_PATH = "/cart";
/** Same wording as the product page (components/store/product/copy.ts cartFull). */
export const CART_FULL_MESSAGE = "Your cart is full. Remove an item to add another.";
export const CART_UNAVAILABLE_MESSAGE = "This renewal can\u2019t be added to the cart. Open the license to see its options.";
