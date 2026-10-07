import { describe, expect, it } from "vitest";
import {
  buildCartRows,
  cartTotals,
  limitsLabel,
  lineKeyOf,
  ratePctLabel,
  toCartPlanCatalog,
  toRequestItems,
  unitLine,
  type CartPlanCatalog,
} from "@/components/store/cart/cart-model";
import { quoteKey } from "@/components/store/cart/use-quote";
import type { CartItem } from "@/lib/cart/store";
import type { QuoteDto, QuoteLineDto } from "@/lib/checkout/quote";
import { fixtureProducts } from "@/lib/storefront/fixtures";

const catalog: CartPlanCatalog = toCartPlanCatalog(fixtureProducts());

function item(planId: string, qty = 1, kind: CartItem["kind"] = "NEW", targetLicenseId: string | null = null, maxQty = qty): CartItem {
  return { key: lineKeyOf({ kind, planId, targetLicenseId }), planId, qty, maxQty, kind, targetLicenseId };
}

function line(planId: string, qty: number, unitPricePaise: number, extra: Partial<QuoteLineDto> = {}): QuoteLineDto {
  const amountPaise = unitPricePaise * qty;
  return {
    planId,
    productId: "p",
    productName: "Server Product",
    productShortName: "Server",
    planName: "Server plan",
    planType: "ANNUAL",
    kind: "NEW",
    qty,
    unitPricePaise,
    amountPaise,
    discountPaise: 0,
    taxablePaise: amountPaise,
    taxPaise: Math.round(amountPaise * 0.18),
    targetLicenseId: null,
    label: "",
    ...extra,
  };
}

function quote(lines: QuoteLineDto[], issues: QuoteDto["issues"] = []): QuoteDto {
  const subtotal = lines.reduce((s, l) => s + l.amountPaise, 0);
  const gst = Math.round((subtotal * 18) / 100);
  const cgst = Math.round(gst / 2);
  return {
    lines,
    subtotalPaise: subtotal,
    discountPaise: 0,
    taxablePaise: subtotal,
    cgstPaise: cgst,
    sgstPaise: gst - cgst,
    igstPaise: 0,
    totalPaise: subtotal + gst,
    gstRatePct: 18,
    intraState: true,
    companyState: "Maharashtra",
    coupon: null,
    issues,
  };
}

describe("cart plan catalog", () => {
  it("maps every live plan to its product's slug, names, icon and tone", () => {
    const annual = catalog["med-annual"];
    expect(annual).toMatchObject({ productSlug: "medical-billing", planName: "Annual license", type: "ANNUAL", interval: "YEAR" });
    expect(annual?.productShortName).toBeTruthy();
    expect(catalog["rst-yearly"]).toMatchObject({ perUnit: "terminal", maxQty: 10 });
  });

  it("builds request items in cart order without the client-only fields", () => {
    const items = [item("med-annual"), item("rst-yearly", 3, "NEW", null, 10)];
    expect(toRequestItems(items)).toEqual([
      { planId: "med-annual", qty: 1, kind: "NEW", targetLicenseId: null },
      { planId: "rst-yearly", qty: 3, kind: "NEW", targetLicenseId: null },
    ]);
  });

  it("keys quote requests by items, coupon and viewer scope", () => {
    const body = { items: toRequestItems([item("med-annual")]) };
    expect(quoteKey(body)).toBe(quoteKey({ ...body, couponCode: null }));
    expect(quoteKey(body)).not.toBe(quoteKey({ ...body, couponCode: "WELCOME10" }));
    expect(quoteKey(body, "guest")).not.toBe(quoteKey(body, "priya@example.com"));
  });
});

describe("cart row text (prototype Cart.dc.html)", () => {
  it("labels limits: terminals, add-on computers, device limit, else Add-on", () => {
    expect(limitsLabel({ type: "SUBSCRIPTION", perUnit: "terminal", deviceLimit: 1 }, 3)).toBe("3 terminals");
    expect(limitsLabel({ type: "SUBSCRIPTION", perUnit: "terminal", deviceLimit: 1 }, 1)).toBe("1 terminal");
    expect(limitsLabel({ type: "DEVICE_ADDON", perUnit: null, deviceLimit: null }, 2)).toBe("2 computers");
    expect(limitsLabel({ type: "ONE_TIME", perUnit: null, deviceLimit: 5 }, 1)).toBe("5 computers");
    expect(limitsLabel({ type: "ANNUAL", perUnit: null, deviceLimit: 1 }, 1)).toBe("1 computer");
    expect(limitsLabel({ type: "MAINTENANCE", perUnit: null, deviceLimit: null }, 1)).toBe("Add-on");
    expect(limitsLabel(null, 1)).toBe("Add-on");
  });

  it("writes the unit line with the target license prefix", () => {
    const yearly = { type: "SUBSCRIPTION" as const, interval: "YEAR" as const, trialDays: null, perUnit: "terminal" };
    expect(unitLine({ kind: "NEW", targetLicenseId: null, unitPricePaise: 699900, plan: yearly })).toBe(
      "₹6,999 /year per terminal · excl. GST",
    );
    const amc = { type: "MAINTENANCE" as const, interval: "YEAR" as const, trialDays: null, perUnit: null };
    expect(unitLine({ kind: "RENEWAL", targetLicenseId: "LIC-24017", unitPricePaise: 299900, plan: amc })).toBe(
      "Renewal of LIC-24017 · ₹2,999 /year · excl. GST",
    );
    const addon = { type: "DEVICE_ADDON" as const, interval: null, trialDays: null, perUnit: null };
    expect(unitLine({ kind: "ADDON", targetLicenseId: "LIC-1", unitPricePaise: 249900, plan: addon })).toBe(
      "Add-on for LIC-1 · ₹2,499 one-time · excl. GST",
    );
    expect(unitLine({ kind: "UPGRADE", targetLicenseId: "LIC-2", unitPricePaise: 100, plan: { ...addon, type: "ONE_TIME" } })).toBe(
      "Upgrade of LIC-2 · ₹1 one-time · excl. GST",
    );
  });

  it("formats tax rates for labels", () => {
    expect(ratePctLabel(18)).toBe("18");
    expect(ratePctLabel(9)).toBe("9");
    expect(ratePctLabel(2.5)).toBe("2.5");
  });
});

describe("buildCartRows", () => {
  it("returns null before the first quote (skeleton)", () => {
    expect(buildCartRows([item("med-annual")], null, catalog)).toBeNull();
  });

  it("matches quote lines by kind, plan and target, in cart order", () => {
    const items = [
      item("rst-yearly", 3, "NEW", null, 10),
      item("med-amc", 1, "RENEWAL", "LIC-24017"),
      item("med-annual"),
    ];
    const q = quote([
      line("med-annual", 1, 499900),
      line("med-amc", 1, 299900, { kind: "RENEWAL", targetLicenseId: "LIC-24017", planType: "MAINTENANCE" }),
      line("rst-yearly", 3, 699900, { planType: "SUBSCRIPTION" }),
    ]);
    const rows = buildCartRows(items, q, catalog) ?? [];
    expect(rows.map((r) => r.planId)).toEqual(["rst-yearly", "med-amc", "med-annual"]);
    const [terminals, renewal, annual] = rows;
    expect(terminals).toMatchObject({
      amountPaise: 2099700,
      limits: "3 terminals",
      stepper: { max: 10 },
      href: "/software/restaurant-billing",
      issue: null,
    });
    expect(terminals?.stepper?.label).toMatch(/^Terminals for /);
    expect(renewal?.unitLine).toBe("Renewal of LIC-24017 · ₹2,999 /year · excl. GST");
    expect(renewal?.stepper).toBeNull();
    expect(annual?.removeLabel).toBe(`Remove ${annual?.shortName} Annual license`);
  });

  it("previews a changed quantity from the last quote's unit price", () => {
    const rows = buildCartRows([item("rst-yearly", 5, "NEW", null, 10)], quote([line("rst-yearly", 3, 699900)]), catalog) ?? [];
    expect(rows[0]?.amountPaise).toBe(699900 * 5);
    expect(rows[0]?.limits).toBe("5 terminals");
  });

  it("caps the stepper at the line's own maximum", () => {
    const rows = buildCartRows([item("rst-yearly", 2, "NEW", null, 4)], quote([line("rst-yearly", 2, 699900)]), catalog) ?? [];
    expect(rows[0]?.stepper?.max).toBe(4);
  });

  it("shows refused lines with the server message and no amount", () => {
    const items = [item("med-amc", 1, "RENEWAL", "LIC-1")];
    const q = quote([], [
      { planId: "med-amc", code: "sign_in_required", message: "Sign in to renew.", index: 0, kind: "RENEWAL", targetLicenseId: "LIC-1" },
    ]);
    const [row] = buildCartRows(items, q, catalog) ?? [];
    expect(row?.issue).toEqual({ code: "sign_in_required", message: "Sign in to renew." });
    expect(row?.amountPaise).toBeNull();
  });

  it("falls back to the quote's names for plans outside the catalog", () => {
    const items = [item("old-plan", 1, "RENEWAL", "LIC-9")];
    const q = quote([line("old-plan", 1, 100000, { kind: "RENEWAL", targetLicenseId: "LIC-9", planType: "ANNUAL" })]);
    const [row] = buildCartRows(items, q, catalog) ?? [];
    expect(row).toMatchObject({ shortName: "Server", planName: "Server plan", href: null, icon: "storefront", amountPaise: 100000 });
    expect(row?.unitLine).toBe("Renewal of LIC-9 · ₹1,000 /year · excl. GST");
  });
});

describe("cartTotals", () => {
  const q = quote([line("med-annual", 1, 499900), line("rst-yearly", 3, 699900)]);

  it("uses the server totals when the quote is current", () => {
    const rows = buildCartRows([item("med-annual"), item("rst-yearly", 3, "NEW", null, 10)], q, catalog) ?? [];
    expect(cartTotals(rows, q, true)).toEqual({
      subtotalPaise: q.subtotalPaise,
      gstPaise: q.cgstPaise + q.sgstPaise,
      totalPaise: q.totalPaise,
      gstRatePct: 18,
    });
  });

  it("previews with gst = round(subtotal * 18%) while re-quoting", () => {
    const rows = buildCartRows([item("med-annual"), item("rst-yearly", 4, "NEW", null, 10)], q, catalog) ?? [];
    const subtotal = 499900 + 699900 * 4;
    const gst = Math.round(subtotal * 0.18);
    expect(cartTotals(rows, q, false)).toEqual({ subtotalPaise: subtotal, gstPaise: gst, totalPaise: subtotal + gst, gstRatePct: 18 });
  });
});
