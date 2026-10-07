/**
 * "Keep the cart until the order is PAID" (decisions.md Phase 3). Checkout remembers which cart lines went into an
 * order (localStorage "axiomatic.cartOrder"); the order page calls clearCartForPaidOrder(orderId) once the status
 * poll reports PAID. Only those lines are removed, so anything added to the cart since stays. Failed, canceled or
 * abandoned payments never touch the cart. Client-only; storage failures are ignored (worst case: the cart stays).
 */
import { cartStore, type CartItem, type StorageLike } from "@/lib/cart/store";

export const CART_ORDER_STORAGE_KEY = "axiomatic.cartOrder";

type Marker = { orderId: string; keys: string[] };

type CartLike = { getSnapshot: () => { items: readonly CartItem[] }; remove: (key: string) => void };

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readMarker(storage: StorageLike | null): Marker | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(CART_ORDER_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Partial<Marker> | null;
    if (!data || typeof data.orderId !== "string" || !Array.isArray(data.keys)) return null;
    return { orderId: data.orderId, keys: data.keys.filter((k): k is string => typeof k === "string") };
  } catch {
    return null;
  }
}

/** Records the cart lines an order was placed from (replaces any earlier marker: one checkout at a time). */
export function rememberCartOrder(
  orderId: string,
  items: readonly Pick<CartItem, "key">[],
  storage: StorageLike | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(CART_ORDER_STORAGE_KEY, JSON.stringify({ orderId, keys: items.map((i) => i.key) }));
  } catch {
    // Storage full or blocked: the cart simply stays until the customer clears it.
  }
}

/**
 * Removes the lines the order was placed from, if this browser placed `orderId`. Returns the number of lines removed
 * (0 when the marker belongs to another order or is missing). Safe to call on every PAID poll.
 */
export function clearCartForPaidOrder(
  orderId: string,
  opts: { storage?: StorageLike | null; cart?: CartLike } = {},
): number {
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  const cart = opts.cart ?? cartStore;
  const marker = readMarker(storage);
  if (!marker || marker.orderId !== orderId) return 0;
  const keys = new Set(marker.keys);
  let removed = 0;
  for (const item of cart.getSnapshot().items) {
    if (!keys.has(item.key)) continue;
    cart.remove(item.key);
    removed += 1;
  }
  try {
    storage?.removeItem(CART_ORDER_STORAGE_KEY);
  } catch {
    // ignore
  }
  return removed;
}
