import { describe, expect, it } from "vitest";
import { CART_ORDER_STORAGE_KEY, clearCartForPaidOrder, rememberCartOrder } from "@/components/checkout/cart-order";
import { createCartStore, type StorageLike } from "@/lib/cart/store";

class FakeStorage implements StorageLike {
  readonly data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

function setup() {
  const storage = new FakeStorage();
  const cart = createCartStore({ storage: () => storage, events: () => null });
  cart.add("med-annual", { maxQty: 1 });
  cart.add("rst-yearly", { qty: 3, maxQty: 10 });
  return { storage, cart };
}

describe("cart kept until the order is paid", () => {
  it("removes only the ordered lines, for the remembered order only", () => {
    const { storage, cart } = setup();
    rememberCartOrder("AX-1", cart.getSnapshot().items, storage);
    cart.add("gst-annual", { maxQty: 1 }); // added after placing the order
    expect(clearCartForPaidOrder("AX-2", { storage, cart })).toBe(0);
    expect(cart.getSnapshot().items).toHaveLength(3);
    expect(clearCartForPaidOrder("AX-1", { storage, cart })).toBe(2);
    expect(cart.getSnapshot().items.map((i) => i.planId)).toEqual(["gst-annual"]);
    expect(storage.getItem(CART_ORDER_STORAGE_KEY)).toBeNull();
    // Idempotent: a second PAID poll changes nothing.
    expect(clearCartForPaidOrder("AX-1", { storage, cart })).toBe(0);
  });

  it("ignores a missing or corrupted marker and missing storage", () => {
    const { storage, cart } = setup();
    storage.setItem(CART_ORDER_STORAGE_KEY, "{not json");
    expect(clearCartForPaidOrder("AX-1", { storage, cart })).toBe(0);
    expect(clearCartForPaidOrder("AX-1", { storage: null, cart })).toBe(0);
    expect(() => rememberCartOrder("AX-1", cart.getSnapshot().items, null)).not.toThrow();
    expect(cart.getSnapshot().items).toHaveLength(2);
  });

  it("replaces the marker on a new checkout", () => {
    const { storage, cart } = setup();
    rememberCartOrder("AX-1", cart.getSnapshot().items, storage);
    rememberCartOrder("AX-2", cart.getSnapshot().items.slice(0, 1), storage);
    expect(clearCartForPaidOrder("AX-1", { storage, cart })).toBe(0);
    expect(clearCartForPaidOrder("AX-2", { storage, cart })).toBe(1);
  });
});
