import { describe, expect, it } from "vitest";
import { addLicenseLines, replacedLineKeys } from "@/components/account/licenses/cart";
import { createCartStore, type StorageLike } from "@/lib/cart/store";

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const store = () => {
  const storage = memoryStorage();
  return createCartStore({ storage: () => storage, events: () => null });
};

const renewal = { planId: "med-annual", qty: 1, maxQty: 1, kind: "RENEWAL" as const, targetLicenseId: "LIC-24017" };

describe("license cart lines", () => {
  it("adds a renewal line for the license and sets (not adds) the quantity when added again", () => {
    const cart = store();
    expect(addLicenseLines([renewal], cart)).toEqual({ added: 1, failed: 0, full: false });
    addLicenseLines([{ ...renewal, qty: 3, maxQty: 10 }], cart);
    const items = cart.getSnapshot().items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ planId: "med-annual", qty: 3, kind: "RENEWAL", targetLicenseId: "LIC-24017" });
  });

  it("keeps renewals and add-ons together but lets an upgrade replace every other line of its license", () => {
    const cart = store();
    cart.add("med-annual", { maxQty: 1 });
    addLicenseLines([renewal, { planId: "med-device", qty: 2, maxQty: 10, kind: "ADDON", targetLicenseId: "LIC-24017" }], cart);
    expect(cart.getSnapshot().items.map((i) => i.kind)).toEqual(["NEW", "RENEWAL", "ADDON"]);
    addLicenseLines([{ planId: "med-onetime", qty: 1, maxQty: 1, kind: "UPGRADE", targetLicenseId: "LIC-24017" }], cart);
    expect(cart.getSnapshot().items.map((i) => i.kind)).toEqual(["NEW", "UPGRADE"]);
    addLicenseLines([renewal], cart);
    expect(cart.getSnapshot().items.map((i) => i.kind)).toEqual(["NEW", "RENEWAL"]);
  });

  it("lists the clashing keys only for the same license", () => {
    const items = [
      { key: "RENEWAL:med-annual:LIC-24017", kind: "RENEWAL" as const, targetLicenseId: "LIC-24017" },
      { key: "RENEWAL:med-annual:LIC-24212", kind: "RENEWAL" as const, targetLicenseId: "LIC-24212" },
      { key: "ADDON:med-device:LIC-24017", kind: "ADDON" as const, targetLicenseId: "LIC-24017" },
    ];
    expect(replacedLineKeys(items, renewal)).toEqual(["RENEWAL:med-annual:LIC-24017"]);
    expect(replacedLineKeys(items, { ...renewal, kind: "UPGRADE", planId: "med-onetime" })).toEqual([
      "RENEWAL:med-annual:LIC-24017",
      "ADDON:med-device:LIC-24017",
    ]);
  });

  it("reports invalid lines without touching the cart", () => {
    const cart = store();
    expect(addLicenseLines([{ ...renewal, planId: "bad id!" }], cart)).toEqual({ added: 0, failed: 1, full: false });
    expect(cart.getSnapshot().items).toHaveLength(0);
  });
});
