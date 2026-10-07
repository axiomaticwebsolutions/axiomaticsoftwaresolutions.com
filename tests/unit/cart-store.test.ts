import { describe, expect, it, vi } from "vitest";
import {
  CART_MAX_LINES,
  CART_STORAGE_KEY,
  createCartStore,
  parseCart,
  serializeCart,
  type StorageLike,
} from "@/lib/cart/store";

/** A localStorage stand-in. Two stores sharing one FakeStorage behave like two tabs of the same site. */
class FakeStorage implements StorageLike {
  readonly data = new Map<string, string>();
  failWrites = false;
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

function setup(storage = new FakeStorage()) {
  const events = new EventTarget();
  const store = createCartStore({ storage: () => storage, events: () => events as unknown as Window });
  return { storage, events, store };
}

const storageEvent = (key: string | null) => Object.assign(new Event("storage"), { key });

describe("cart store", () => {
  it("starts empty with stable snapshots (server and client)", () => {
    const { store } = setup();
    expect(store.getSnapshot()).toEqual({ items: [], count: 0 });
    expect(store.getSnapshot()).toBe(store.getSnapshot());
    expect(store.getServerSnapshot()).toBe(store.getServerSnapshot());
    expect(store.getServerSnapshot().count).toBe(0);
  });

  it("adds lines, merges repeats up to maxQty and counts quantities", () => {
    const { store, storage } = setup();
    expect(store.add("med-annual", { qty: 1, maxQty: 1 })).toMatchObject({ ok: true, capped: false, item: { qty: 1 } });
    // A non-per-unit NEW line stays at 1.
    expect(store.add("med-annual", { qty: 1, maxQty: 1 })).toMatchObject({ ok: true, capped: true, item: { qty: 1 } });
    expect(store.add("rst-monthly", { qty: 3, maxQty: 10 })).toMatchObject({ ok: true, capped: false });
    expect(store.add("rst-monthly", { qty: 9, maxQty: 10 })).toMatchObject({ ok: true, capped: true, item: { qty: 10 } });
    const snap = store.getSnapshot();
    expect(snap.items.map((i) => [i.planId, i.qty, i.kind])).toEqual([
      ["med-annual", 1, "NEW"],
      ["rst-monthly", 10, "NEW"],
    ]);
    expect(snap.count).toBe(11);
    expect(snap).toBe(store.getSnapshot());
    expect(JSON.parse(storage.getItem(CART_STORAGE_KEY) ?? "")).toEqual({
      v: 1,
      items: [
        { planId: "med-annual", qty: 1, maxQty: 1, kind: "NEW", targetLicenseId: null },
        { planId: "rst-monthly", qty: 10, maxQty: 10, kind: "NEW", targetLicenseId: null },
      ],
    });
  });

  it("keeps renewal and add-on lines for a license separate from new purchases", () => {
    const { store } = setup();
    store.add("med-annual", { maxQty: 1 });
    store.add("med-annual", { maxQty: 1, kind: "RENEWAL", targetLicenseId: "LIC-24017" });
    store.add("med-device", { maxQty: 5, kind: "ADDON", targetLicenseId: "LIC-24017", qty: 2 });
    store.add("med-annual", { maxQty: 1, kind: "RENEWAL", targetLicenseId: "LIC-24017" });
    expect(store.getSnapshot().items.map((i) => i.key)).toEqual([
      "NEW:med-annual:",
      "RENEWAL:med-annual:LIC-24017",
      "ADDON:med-device:LIC-24017",
    ]);
    expect(store.getSnapshot().count).toBe(4);
  });

  it("sets quantities within 1..maxQty, removes lines and clears", () => {
    const { store } = setup();
    store.add("rst-yearly", { qty: 2, maxQty: 10 });
    const key = store.getSnapshot().items[0]?.key ?? "";
    store.setQty(key, 7);
    expect(store.getSnapshot().count).toBe(7);
    store.setQty(key, 50);
    expect(store.getSnapshot().count).toBe(10);
    store.setQty(key, 0);
    expect(store.getSnapshot().count).toBe(1);
    store.setQty(key, Number.NaN);
    store.setQty("missing", 3);
    expect(store.getSnapshot().count).toBe(1);
    store.add("gst-onetime", { maxQty: 1 });
    store.remove(key);
    expect(store.getSnapshot().items.map((i) => i.planId)).toEqual(["gst-onetime"]);
    store.clear();
    expect(store.getSnapshot()).toEqual({ items: [], count: 0 });
  });

  it("refuses invalid input and more than the maximum number of lines", () => {
    const { store } = setup();
    expect(store.add("", { maxQty: 1 })).toEqual({ ok: false, reason: "invalid" });
    expect(store.add("bad id!", { maxQty: 1 })).toEqual({ ok: false, reason: "invalid" });
    expect(store.add("med-annual", { qty: 0, maxQty: 1 })).toEqual({ ok: false, reason: "invalid" });
    expect(store.add("med-annual", { qty: 1.5, maxQty: 1 })).toEqual({ ok: false, reason: "invalid" });
    expect(store.add("med-annual", { maxQty: 1000 })).toEqual({ ok: false, reason: "invalid" });
    expect(store.add("med-annual", { maxQty: 1, targetLicenseId: "<x>" })).toEqual({ ok: false, reason: "invalid" });
    for (let i = 0; i < CART_MAX_LINES; i++) store.add(`plan-${i}`, { maxQty: 1 });
    expect(store.add("one-more", { maxQty: 1 })).toEqual({ ok: false, reason: "full" });
    expect(store.add("plan-0", { maxQty: 1 })).toMatchObject({ ok: true });
  });

  it("notifies subscribers and follows changes made in another tab", () => {
    const shared = new FakeStorage();
    const tabA = setup(shared);
    const tabB = setup(shared);
    const listener = vi.fn();
    const unsubscribe = tabB.store.subscribe(listener);
    tabA.store.add("chq-office", { maxQty: 1 });
    // The browser fires `storage` in the other tab only.
    tabB.events.dispatchEvent(storageEvent(CART_STORAGE_KEY));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(tabB.store.getSnapshot().items.map((i) => i.planId)).toEqual(["chq-office"]);
    tabB.events.dispatchEvent(storageEvent("something-else"));
    expect(listener).toHaveBeenCalledTimes(1);
    tabB.events.dispatchEvent(storageEvent(null)); // localStorage.clear() elsewhere
    expect(listener).toHaveBeenCalledTimes(2);
    tabB.store.add("gst-annual", { maxQty: 1 });
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    tabB.store.clear();
    tabB.events.dispatchEvent(storageEvent(CART_STORAGE_KEY));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("keeps working in memory when storage refuses writes", () => {
    const { store, storage } = setup();
    storage.failWrites = true;
    store.add("med-annual", { maxQty: 1 });
    expect(store.getSnapshot().count).toBe(1);
    store.add("rst-monthly", { qty: 2, maxQty: 10 });
    expect(store.getSnapshot().count).toBe(3);
    expect(storage.getItem(CART_STORAGE_KEY)).toBeNull();
  });

  it("works without any storage (server or blocked storage)", () => {
    const store = createCartStore({ storage: () => null, events: () => null });
    expect(store.getSnapshot().count).toBe(0);
    store.add("med-annual", { maxQty: 1 });
    expect(store.getSnapshot().count).toBe(1);
  });
});

describe("stored cart parsing", () => {
  it("drops corrupted values and invalid lines instead of failing", () => {
    expect(parseCart(null).items).toEqual([]);
    expect(parseCart("{not json").items).toEqual([]);
    expect(parseCart("42").items).toEqual([]);
    expect(parseCart('{"v":1,"items":"nope"}').items).toEqual([]);
    const parsed = parseCart(
      JSON.stringify({
        v: 1,
        items: [
          { planId: "med-annual", qty: 1, maxQty: 1, kind: "NEW", targetLicenseId: null },
          { planId: "<script>", qty: 1 },
          { planId: "rst-monthly", qty: -2 },
          { planId: "rst-monthly", qty: 2, maxQty: 10, kind: "BOGUS" },
          null,
        ],
      }),
    );
    expect(parsed.items.map((i) => i.planId)).toEqual(["med-annual"]);
  });

  it("accepts the prototype's bare array, merges duplicates and clamps to maxQty", () => {
    const parsed = parseCart(
      JSON.stringify([
        { planId: "rst-monthly", qty: 2 },
        { planId: "gst-annual", qty: 3, maxQty: 1 },
        { planId: "rst-monthly", qty: 1, maxQty: 10 },
      ]),
    );
    expect(parsed.items.map((i) => [i.planId, i.qty, i.maxQty])).toEqual([
      ["rst-monthly", 2, 2],
      ["gst-annual", 1, 1],
    ]);
    expect(parsed.count).toBe(3);
    expect(parseCart(serializeCart(parsed))).toEqual(parsed);
  });
});
