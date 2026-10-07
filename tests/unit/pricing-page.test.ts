import { describe, expect, it } from "vitest";
import { aboutProductTiles, companyDetailRows, withMark } from "@/components/store/about/about-model";
import {
  PRICING_COLUMN_KEYS,
  buildPricingMatrix,
  formatRate,
  gstExample,
  gstExamplePlan,
  halfRate,
  matrixCell,
  matrixUnit,
  monthsLabel,
  oneTimeUpdatePeriod,
  periodAdjective,
  periodSpan,
  planInColumn,
} from "@/components/store/pricing/pricing-model";
import { ABOUT_HERO, ABOUT_PRINCIPLES } from "@/content/about";
import {
  GST_COPY,
  MAINTENANCE_COPY,
  PRICING_MATRIX,
  licenseTypeCards,
  updatePeriodLabel,
} from "@/content/pricing";
import { SETTING_DEFAULTS } from "@/lib/config";
import { fixtureProducts } from "@/lib/storefront/fixtures";
import type { StorePlan, StoreProduct } from "@/lib/storefront/types";

const TAX = { gstRatePct: 18, companyState: "Maharashtra" };

function plan(overrides: Partial<StorePlan> & Pick<StorePlan, "id" | "type" | "pricePaise">): StorePlan {
  return {
    productId: "p",
    name: overrides.id,
    summary: null,
    includes: [],
    interval: null,
    trialDays: null,
    deviceLimit: 1,
    perUnit: null,
    maxQty: null,
    multiDevice: false,
    updatesMonths: null,
    popular: false,
    sortOrder: 0,
    ...overrides,
  };
}

function product(plans: StorePlan[], id = "p"): Pick<StoreProduct, "id" | "shortName" | "icon" | "tone" | "plans"> {
  return { id, shortName: id.toUpperCase(), icon: "storefront", tone: "sage", plans };
}

const products = fixtureProducts();

describe("pricing matrix", () => {
  it("has the prototype's six columns", () => {
    expect(PRICING_COLUMN_KEYS).toEqual(["trial", "one_time", "annual", "subscription", "multi", "maintenance"]);
    expect(Object.keys(PRICING_MATRIX.columns)).toEqual([...PRICING_COLUMN_KEYS]);
  });

  it("puts multi-device and per-unit licenses in MULTI-DEVICE, and keeps multi-device plans out of ONE-TIME", () => {
    const multi = plan({ id: "m", type: "ONE_TIME", pricePaise: 1, multiDevice: true });
    const perUnit = plan({ id: "u", type: "SUBSCRIPTION", pricePaise: 1, interval: "MONTH", perUnit: "terminal" });
    const addOn = plan({ id: "a", type: "DEVICE_ADDON", pricePaise: 1, perUnit: "computer" });
    expect(planInColumn(multi, "one_time")).toBe(false);
    expect(planInColumn(multi, "multi")).toBe(true);
    expect(planInColumn(perUnit, "multi")).toBe(true);
    expect(planInColumn(perUnit, "subscription")).toBe(true);
    expect(planInColumn(addOn, "multi")).toBe(false);
  });

  it("shows the cheapest plan per column, the first one on a tie", () => {
    const plans = [
      plan({ id: "y", type: "SUBSCRIPTION", pricePaise: 699900, interval: "YEAR" }),
      plan({ id: "m1", type: "SUBSCRIPTION", pricePaise: 69900, interval: "MONTH" }),
      plan({ id: "m2", type: "SUBSCRIPTION", pricePaise: 69900, interval: "MONTH" }),
    ];
    expect(matrixCell(plans, "subscription")).toMatchObject({ offered: true, planId: "m1", pricePaise: 69900, unit: "/month" });
    expect(matrixCell(plans, "annual")).toEqual({ key: "annual", offered: false });
  });

  it("labels units like the prototype", () => {
    expect(matrixUnit(plan({ id: "t", type: "TRIAL", pricePaise: 0, trialDays: 15 }))).toBe("15 days");
    expect(matrixUnit(plan({ id: "s", type: "SUBSCRIPTION", pricePaise: 1, interval: "MONTH", perUnit: "terminal" }))).toBe(
      "/month per terminal",
    );
    expect(matrixUnit(plan({ id: "m", type: "ONE_TIME", pricePaise: 1, multiDevice: true, deviceLimit: 5 }))).toBe(
      "up to 5 devices",
    );
    expect(matrixUnit(plan({ id: "o", type: "ONE_TIME", pricePaise: 1 }))).toBe("one-time");
    expect(matrixUnit(plan({ id: "a", type: "MAINTENANCE", pricePaise: 1, interval: "YEAR" }))).toBe("/year");
  });

  it("reproduces the prototype matrix from the sample catalog", () => {
    const rows = buildPricingMatrix(products);
    const view = rows.map((r) => [
      r.name,
      ...r.cells.map((c) => (c.offered ? `${c.free ? "Free" : c.pricePaise / 100} ${c.unit}` : "—")),
    ]);
    expect(view).toEqual([
      ["Medical Store Billing", "Free 15 days", "12999 one-time", "4999 /year", "—", "—", "2999 /year"],
      ["Restaurant Billing", "Free 7 days", "—", "—", "699 /month per terminal", "699 /month per terminal", "—"],
      ["General Store GST Billing", "Free 15 days", "7999 one-time", "3499 /year", "—", "19999 up to 5 devices", "1999 /year"],
      ["Cheque Printing", "—", "2999 one-time", "—", "—", "6999 up to 3 devices", "999 /year"],
    ]);
    expect(rows[0]).toMatchObject({ href: "/software/medical-billing#plans", icon: "medication", tone: "sage" });
  });
});

describe("GST worked example", () => {
  it("prices the top-ranked product's annual plan with quote(): ₹4,999.00 + ₹899.82 = ₹5,898.82", () => {
    expect(gstExamplePlan(products)?.id).toBe("med-annual");
    expect(gstExample(products, TAX)).toEqual({
      planName: "Annual license",
      basePaise: 499900,
      gstPaise: 89982,
      totalPaise: 589882,
      ratePct: 18,
    });
  });

  it("follows the GST rate from settings", () => {
    expect(gstExample(products, { ...TAX, gstRatePct: 12 })).toMatchObject({ gstPaise: 59988, totalPaise: 559888, ratePct: 12 });
  });

  it("uses the next product with an annual plan, then the cheapest paid license, then nothing", () => {
    const oneTimeOnly = product([plan({ id: "o", type: "ONE_TIME", pricePaise: 299900 })], "a");
    const annual = product([plan({ id: "y", type: "ANNUAL", pricePaise: 349900, interval: "YEAR" })], "b");
    expect(gstExamplePlan([oneTimeOnly, annual])?.id).toBe("y");
    expect(gstExamplePlan([oneTimeOnly])?.id).toBe("o");
    const trialOnly = product([plan({ id: "t", type: "TRIAL", pricePaise: 0, trialDays: 7 })]);
    expect(gstExamplePlan([trialOnly])).toBeNull();
    expect(gstExample([], TAX)).toBeNull();
  });
});

describe("numbers the copy quotes", () => {
  it("reads the one-time update period from the plans", () => {
    expect(oneTimeUpdatePeriod(products)).toEqual({ months: 12, varies: false });
    const mixed = [product([plan({ id: "a", type: "ONE_TIME", pricePaise: 1, updatesMonths: 24 }), plan({ id: "b", type: "ONE_TIME", pricePaise: 1 })])];
    expect(oneTimeUpdatePeriod(mixed)).toEqual({ months: 12, varies: true });
    expect(oneTimeUpdatePeriod([product([plan({ id: "c", type: "ONE_TIME", pricePaise: 1, updatesMonths: 6 })])])).toEqual({
      months: 6,
      varies: false,
    });
    expect(oneTimeUpdatePeriod([])).toEqual({ months: 12, varies: false });
    expect(updatePeriodLabel(monthsLabel(12), true)).toBe("at least 12 months");
  });

  it("formats rates and periods", () => {
    expect(formatRate(18)).toBe("18");
    expect(halfRate(18)).toBe("9");
    expect(halfRate(5)).toBe("2.5");
    expect(monthsLabel(1)).toBe("1 month");
    expect(periodAdjective(12)).toBe("yearly");
    expect(periodAdjective(6)).toBe("6-month");
    expect(periodSpan(12)).toBe("a year");
    expect(periodSpan(18)).toBe("18 months");
  });

  it("builds the prototype copy from the values", () => {
    expect(GST_COPY.body("18", "9")).toBe(
      "Software licenses attract 18% GST. If your billing address is in the same state as ours, the invoice shows CGST 9% + SGST 9%. Otherwise it shows IGST 18%. Add your GSTIN at checkout to claim input tax credit.",
    );
    expect(MAINTENANCE_COPY.body({ oneTimeUpdates: "12 months", maintenanceAdjective: "yearly" })).toMatch(
      /^One-time licenses include 12 months of updates and support\. .* A yearly maintenance plan restarts/,
    );
    const cards = licenseTypeCards({ oneTimeUpdates: "12 months", maintenanceCover: "12 months", maintenanceSpan: "a year" });
    expect(cards.map((c) => c.name)).toEqual([
      "Free trial",
      "One-time license",
      "Annual license",
      "Subscription",
      "Multi-device",
      "Maintenance plan",
    ]);
    expect(cards[1]?.updates).toBe("12 months included, then optional maintenance");
    expect(cards[5]?.what).toBe("An add-on for one-time licenses that restarts updates and priority support for a year.");
    expect(cards[5]?.updates).toBe("12 months from purchase");
  });

  it("never promises automatic subscription renewal (decision 2)", () => {
    const subscription = licenseTypeCards({ oneTimeUpdates: "12 months", maintenanceCover: "12 months", maintenanceSpan: "a year" })[3];
    expect(subscription?.what).toContain("nothing is charged automatically");
    expect(subscription?.what).not.toMatch(/cancel any time/i);
  });
});

describe("about page helpers", () => {
  const business = SETTING_DEFAULTS.business;

  it("marks the sample company details like the prototype", () => {
    expect(companyDetailRows(business).map((r) => [r.term, r.value])).toEqual([
      ["Registered name", "Axiomatic Software Solutions (placeholder)"],
      ["GSTIN", "27AAAAA0000A1Z5 (sample)"],
      ["Office", "Pune, Maharashtra (placeholder)"],
      ["Support hours", "Mon–Sat, 10:00–19:00 IST"],
    ]);
  });

  it("drops the marks and empty values once the details are real", () => {
    const real = { ...business, legalName: "Axiomatic Software Solutions Pvt. Ltd.", city: "", sample: false };
    expect(companyDetailRows(real).map((r) => r.value)).toEqual([
      "Axiomatic Software Solutions Pvt. Ltd.",
      "27AAAAA0000A1Z5",
      "Maharashtra",
      "Mon–Sat, 10:00–19:00 IST",
    ]);
  });

  it("appends a mark only once", () => {
    expect(withMark("Pune", "(placeholder)")).toBe("Pune (placeholder)");
    expect(withMark("Pune (placeholder)", "(placeholder)")).toBe("Pune (placeholder)");
    expect(withMark("Pune", null)).toBe("Pune");
  });

  it("lists every product with its icon, tone and category", () => {
    expect(aboutProductTiles(products)).toEqual([
      { id: "medical-billing", name: "Medical Store Billing", category: "Medical & Pharmacy", icon: "medication", tone: "sage", href: "/software/medical-billing" },
      { id: "restaurant-billing", name: "Restaurant Billing", category: "Restaurants & Cafés", icon: "restaurant", tone: "peach", href: "/software/restaurant-billing" },
      { id: "general-store-gst", name: "General Store GST Billing", category: "Retail & Grocery", icon: "storefront", tone: "blue", href: "/software/general-store-gst" },
      { id: "cheque-printing", name: "Cheque Printing", category: "Finance & Office", icon: "edit_document", tone: "lavender", href: "/software/cheque-printing" },
    ]);
  });

  it("keeps the prototype copy", () => {
    expect(ABOUT_HERO.heading).toBe("Software that does its job, every working day.");
    expect(ABOUT_PRINCIPLES.items.map((p) => p.title)).toEqual([
      "Focused products",
      "Straight licensing",
      "Steady improvement",
      "Your data, your computer",
    ]);
  });
});
