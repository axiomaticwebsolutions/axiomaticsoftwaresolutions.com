/**
 * Adds renewal, add-on and upgrade lines for existing licenses to the visitor's cart (lib/cart/store; the server
 * re-prices and re-checks every line at checkout). Checkout allows one line per license and kind, and an upgrade
 * must be the only line for its license, so lines that would clash are replaced, as the prototype's addRenewal()
 * did. Client-safe, no React.
 */
import { cartLineKey, cartStore, type CartItem, type CartStore } from "@/lib/cart/store";
import type { CartLineSpec } from "./model";

type CartLineLike = Pick<CartItem, "key" | "kind" | "targetLicenseId">;

/** Cart lines the new line replaces: the same line (its quantity is set again, not added) and clashing kinds. */
export function replacedLineKeys(items: readonly CartLineLike[], line: CartLineSpec): string[] {
  const key = cartLineKey(line);
  return items
    .filter(
      (item) =>
        item.targetLicenseId === line.targetLicenseId &&
        (item.key === key || item.kind === "UPGRADE" || line.kind === "UPGRADE" || item.kind === line.kind),
    )
    .map((item) => item.key);
}

export type AddLinesResult = { added: number; failed: number; full: boolean };

/** Adds each line (replacing clashing lines first). Returns how many were added. */
export function addLicenseLines(lines: readonly CartLineSpec[], store: CartStore = cartStore): AddLinesResult {
  let added = 0;
  let failed = 0;
  let full = false;
  for (const line of lines) {
    for (const key of replacedLineKeys(store.getSnapshot().items, line)) store.remove(key);
    const result = store.add(line.planId, {
      qty: line.qty,
      maxQty: line.maxQty,
      kind: line.kind,
      targetLicenseId: line.targetLicenseId,
    });
    if (result.ok) added += 1;
    else {
      failed += 1;
      if (result.reason === "full") full = true;
    }
  }
  return { added, failed, full };
}

/** Toast copy when nothing could be added. */
export const CART_FULL_MESSAGE = "Your cart is full. Remove an item and try again.";
export const CART_FAILED_MESSAGE = "We couldn’t add that to your cart. Please try again.";
export const CART_PATH = "/cart";

/**
 * Shows a toast shortly after the browser reaches `path`: the portal's toaster unmounts on the way to the cart and
 * Sonner does not replay earlier toasts, so the cart page's own toaster has to show it. Gives up after 6 s.
 */
export function toastAfterNavigation(path: string, show: () => void, timeoutMs = 6000): void {
  const started = Date.now();
  const timer = window.setInterval(() => {
    if (window.location.pathname === path) {
      window.clearInterval(timer);
      // Let the new page mount its toaster first.
      window.setTimeout(show, 600);
    } else if (Date.now() - started > timeoutMs) {
      window.clearInterval(timer);
    }
  }, 100);
}
