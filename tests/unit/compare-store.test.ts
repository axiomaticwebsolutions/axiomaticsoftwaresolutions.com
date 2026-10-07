import { describe, expect, it, vi } from "vitest";
import type { StorageLike } from "@/lib/cart/store";
import {
  COMPARE_MAX,
  COMPARE_STORAGE_KEY,
  createCompareStore,
  normalizeCompareIds,
  parseCompare,
  parseCompareParam,
} from "@/lib/compare/store";

function fakeStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function setup(storage = fakeStorage()) {
  const events = new EventTarget();
  const store = createCompareStore({ storage: () => storage, events: () => events as unknown as Window });
  return { storage, events, store };
}

describe("compare store", () => {
  it("toggles products in and out, up to three", () => {
    const { store, storage } = setup();
    expect(COMPARE_MAX).toBe(3);
    expect(store.getSnapshot()).toEqual([]);
    expect(store.toggle("medical-billing")).toEqual({ ok: true, selected: true });
    expect(store.toggle("general-store-gst")).toEqual({ ok: true, selected: true });
    expect(store.toggle("cheque-printing")).toEqual({ ok: true, selected: true });
    expect(store.toggle("restaurant-billing")).toEqual({ ok: false, reason: "max" });
    expect(store.getSnapshot()).toEqual(["medical-billing", "general-store-gst", "cheque-printing"]);
    expect(JSON.parse(storage.getItem(COMPARE_STORAGE_KEY) ?? "")).toEqual(["medical-billing", "general-store-gst", "cheque-printing"]);
    expect(store.toggle("general-store-gst")).toEqual({ ok: true, selected: false });
    expect(store.toggle("restaurant-billing")).toEqual({ ok: true, selected: true });
    expect(store.getSnapshot()).toEqual(["medical-billing", "cheque-printing", "restaurant-billing"]);
  });

  it("removes, replaces and clears", () => {
    const { store } = setup();
    store.replace(["general-store-gst", "general-store-gst", "Bad Slug", "cheque-printing", "medical-billing", "restaurant-billing"]);
    expect(store.getSnapshot()).toEqual(["general-store-gst", "cheque-printing", "medical-billing"]);
    const before = store.getSnapshot();
    store.replace(["general-store-gst", "cheque-printing", "medical-billing"]);
    expect(store.getSnapshot()).toBe(before);
    store.remove("cheque-printing");
    store.remove("not-selected");
    expect(store.getSnapshot()).toEqual(["general-store-gst", "medical-billing"]);
    store.clear();
    expect(store.getSnapshot()).toEqual([]);
  });

  it("keeps snapshots stable, starts empty on the server and follows other tabs", () => {
    const storage = fakeStorage();
    const tabA = setup(storage);
    const tabB = setup(storage);
    expect(tabB.store.getServerSnapshot()).toEqual([]);
    expect(tabB.store.getSnapshot()).toBe(tabB.store.getSnapshot());
    const listener = vi.fn();
    tabB.store.subscribe(listener);
    tabA.store.toggle("cheque-printing");
    tabB.events.dispatchEvent(Object.assign(new Event("storage"), { key: COMPARE_STORAGE_KEY }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(tabB.store.getSnapshot()).toEqual(["cheque-printing"]);
  });
});

describe("compare parsing", () => {
  it("validates stored values", () => {
    expect(parseCompare(null)).toEqual([]);
    expect(parseCompare("not json")).toEqual([]);
    expect(parseCompare('{"a":1}')).toEqual([]);
    expect(parseCompare('["medical-billing", 42, "../x", "medical-billing", "a", "b", "c"]')).toEqual(["medical-billing", "a", "b"]);
  });

  it("reads /compare?ids=", () => {
    expect(parseCompareParam("medical-billing, general-store-gst,medical-billing,cheque-printing,restaurant-billing")).toEqual([
      "medical-billing",
      "general-store-gst",
      "cheque-printing",
    ]);
    expect(parseCompareParam(null)).toEqual([]);
    expect(parseCompareParam("")).toEqual([]);
    expect(normalizeCompareIds(["UPPER", "ok-1", "-bad", "bad-", "ok-1"])).toEqual(["ok-1"]);
  });
});
