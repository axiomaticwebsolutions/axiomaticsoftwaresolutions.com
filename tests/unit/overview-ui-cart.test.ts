import { describe, expect, it } from "vitest";
import { addRenewalToCart, conflictingLines, RENEWAL_LINE_MAX_QTY, renewalCartLine } from "@/components/account/overview/cart-renewal";
import { CART_MAX_LINES, createCartStore, type StorageLike } from "@/lib/cart/store";

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function store() {
  const storage = memoryStorage();
  return createCartStore({ storage: () => storage, events: () => null });
}

describe("renewal cart lines (prototype addRenewal)", () => {
  it("maps renewal options to RENEWAL / UPGRADE lines and refuses others", () => {
    expect(renewalCartLine("LIC-1", { kind: "RENEWAL", planId: "med-annual", qty: 1 })).toEqual({
      planId: "med-annual",
      qty: 1,
      maxQty: RENEWAL_LINE_MAX_QTY,
      kind: "RENEWAL",
      targetLicenseId: "LIC-1",
    });
    expect(renewalCartLine("LIC-1", { kind: "UPGRADE", planId: "gst-annual", qty: 1 })?.kind).toBe("UPGRADE");
    expect(renewalCartLine("LIC-1", { kind: "RENEWAL", planId: "rst-yearly", qty: 14 })?.maxQty).toBe(14);
    expect(renewalCartLine("LIC-1", { kind: "ADDON", planId: "med-device", qty: 1 })).toBeNull();
    expect(renewalCartLine("LIC 1", { kind: "RENEWAL", planId: "med-annual", qty: 1 })).toBeNull();
    expect(renewalCartLine("LIC-1", { kind: "RENEWAL", planId: "med-annual", qty: 0 })?.qty).toBe(1);
  });

  it("replaces an existing renewal of the license instead of adding to it, and keeps add-ons", () => {
    const cart = store();
    cart.add("med-annual", { qty: 1, maxQty: 10, kind: "RENEWAL", targetLicenseId: "LIC-1" });
    cart.add("med-device", { qty: 2, maxQty: 4, kind: "ADDON", targetLicenseId: "LIC-1" });
    cart.add("med-annual", { qty: 1, maxQty: 10, kind: "RENEWAL", targetLicenseId: "LIC-2" });
    const result = addRenewalToCart(cart, "LIC-1", { kind: "RENEWAL", planId: "med-annual", qty: 1 });
    expect(result.ok).toBe(true);
    const lines = cart.getSnapshot().items.map((i) => `${i.kind}:${i.planId}:${i.targetLicenseId}:${i.qty}`);
    expect(lines.sort()).toEqual(["ADDON:med-device:LIC-1:2", "RENEWAL:med-annual:LIC-1:1", "RENEWAL:med-annual:LIC-2:1"]);
  });

  it("an UPGRADE (trial to paid) replaces every line of that license", () => {
    const cart = store();
    cart.add("gst-device", { qty: 1, maxQty: 4, kind: "ADDON", targetLicenseId: "LIC-T" });
    cart.add("gst-annual", { qty: 1, maxQty: 1 });
    expect(conflictingLines(cart.getSnapshot().items, { kind: "UPGRADE", targetLicenseId: "LIC-T" })).toHaveLength(1);
    addRenewalToCart(cart, "LIC-T", { kind: "UPGRADE", planId: "gst-annual", qty: 1 });
    const lines = cart.getSnapshot().items.map((i) => `${i.kind}:${i.planId}:${i.targetLicenseId ?? ""}`);
    expect(lines.sort()).toEqual(["NEW:gst-annual:", "UPGRADE:gst-annual:LIC-T"]);
  });

  it("a RENEWAL replaces a pending UPGRADE of the same license", () => {
    const cart = store();
    cart.add("gst-annual", { qty: 1, maxQty: 1, kind: "UPGRADE", targetLicenseId: "LIC-T" });
    addRenewalToCart(cart, "LIC-T", { kind: "RENEWAL", planId: "gst-annual", qty: 1 });
    expect(cart.getSnapshot().items.map((i) => i.kind)).toEqual(["RENEWAL"]);
  });

  it("reports a full cart and unsupported options without changing the cart", () => {
    const cart = store();
    for (let i = 0; i < CART_MAX_LINES; i += 1) cart.add(`plan-${i}`, { qty: 1, maxQty: 1 });
    expect(addRenewalToCart(cart, "LIC-9", { kind: "RENEWAL", planId: "med-annual", qty: 1 })).toEqual({ ok: false, reason: "full" });
    expect(addRenewalToCart(cart, "LIC-9", { kind: "ADDON", planId: "med-device", qty: 1 })).toEqual({ ok: false, reason: "unsupported" });
    expect(cart.getSnapshot().items).toHaveLength(CART_MAX_LINES);
  });
});
