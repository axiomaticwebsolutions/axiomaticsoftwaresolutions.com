import { describe, expect, it } from "vitest";
import { ICON_PATHS } from "@/components/icons/registry";
import { HOME_TONE_CLASSES } from "@/components/store/home/styles";
import {
  announcementHref,
  announcementText,
  categoryCountLabel,
  DEFAULT_UPDATES_MONTHS,
  HERO_ILLUSTRATION,
  HOME_CATEGORIES,
  HOME_CTAS,
  HOME_FAQ,
  HOME_FEATURED,
  HOME_FINAL_CTA,
  HOME_HERO,
  HOME_HOW,
  HOME_MAINTENANCE,
  HOME_META,
  HOME_SUPPORT,
  HOME_WHY,
  maintenanceBody,
  oneTimeUpdatesMonths,
  priceNote,
  productSecondaryCta,
} from "@/content/home";
import { TONE_NAMES } from "@/lib/design/tokens";
import { startingPlan, unitLabel } from "@/lib/storefront/derive";
import { fixtureCategories, fixtureFaqs, fixtureLatestRelease, fixtureProducts } from "@/lib/storefront/fixtures";
import type { StoreLatestRelease, StorePlan, StoreProduct } from "@/lib/storefront/types";

const products = fixtureProducts();

function plan(overrides: Partial<StorePlan>): StorePlan {
  return {
    id: "p",
    productId: "x",
    type: "ANNUAL",
    name: "Plan",
    summary: null,
    includes: [],
    pricePaise: 100000,
    interval: "YEAR",
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

function product(overrides: Partial<Pick<StoreProduct, "id" | "plans" | "demoEnabled">>) {
  return { id: "demo-product", plans: [plan({})], demoEnabled: true, ...overrides };
}

describe("Home copy (verbatim from Home.dc.html)", () => {
  it("has the prototype's title, description and hero copy", () => {
    expect(HOME_META.title).toBe("Axiomatic Software Solutions — Smart software for everyday business");
    expect(HOME_META.description).toBe(
      "Licensed billing, GST invoicing and cheque printing software for Indian businesses. Buy, download and activate in minutes.",
    );
    expect(HOME_HERO.title).toBe("Smart software for everyday business.");
    expect(HOME_HERO.body).toContain("activate it with a key — your data stays with you.");
    expect(HOME_HERO.bullets).toEqual([
      "Free trials on selected products",
      "GST invoice with every purchase",
      "Works offline after activation",
    ]);
    expect(HOME_CTAS).toEqual({ explore: "Explore Software", demo: "Request a Demo" });
    expect(HERO_ILLUSTRATION.description).toBe(
      "Illustrative preview of General Store GST Billing and Cheque Printing software",
    );
    expect(HERO_ILLUSTRATION.window.rows).toHaveLength(4);
    expect(HERO_ILLUSTRATION.license.detail).toBe("2 of 3 computers · renews 16 Nov");
  });

  it("has every section heading", () => {
    expect([
      HOME_FEATURED.title,
      HOME_CATEGORIES.title,
      HOME_WHY.title,
      HOME_HOW.title,
      HOME_SUPPORT.title,
      HOME_MAINTENANCE.title,
      HOME_FAQ.title,
      HOME_FINAL_CTA.title,
    ]).toEqual([
      "Built for the way your shop runs",
      "Find software for your type of business",
      "Straightforward software you can rely on every day",
      "Purchase, download, activate",
      "Help from people who know the software",
      "Keep one-time licenses up to date",
      "Questions business owners ask us",
      "Try it at your own counter.",
    ]);
    expect(HOME_CATEGORIES.more.body).toBe("Tell us what your business needs and we'll let you know when it's ready.");
    expect(HOME_HOW.note).toBe("Licenses are issued only after our server confirms your payment with the payment provider.");
  });

  it("lists 6 benefits and 3 steps with registry icons and known tones", () => {
    expect(HOME_WHY.benefits).toHaveLength(6);
    expect(HOME_HOW.steps).toHaveLength(3);
    expect(HOME_MAINTENANCE.items).toHaveLength(3);
    for (const item of [...HOME_WHY.benefits, ...HOME_HOW.steps]) {
      expect(Object.hasOwn(ICON_PATHS, item.icon)).toBe(true);
      expect(TONE_NAMES).toContain(item.tone);
    }
    expect(new Set(HOME_WHY.benefits.map((b) => b.title)).size).toBe(6);
  });

  it("has tone classes for every tone", () => {
    expect(Object.keys(HOME_TONE_CLASSES).sort()).toEqual([...TONE_NAMES].sort());
  });
});

describe("Home copy derived from data", () => {
  const latest: StoreLatestRelease = {
    product: { id: "general-store-gst", name: "General Store GST Billing Software", shortName: "General Store GST Billing" },
    release: { version: "5.0.2", releasedAt: "2026-09-29T18:30:00.000Z", notes: [], sizeLabel: "164 MB", platforms: ["windows"] },
  };

  it("builds the announcement from the newest release (major.minor) and links to its release notes", () => {
    expect(announcementText(latest)).toBe("General Store GST Billing 5.0 is out");
    expect(announcementHref(latest)).toBe("/software/general-store-gst#releases");
  });

  it("pluralises the category count", () => {
    expect(categoryCountLabel(1)).toBe("1 product");
    expect(categoryCountLabel(2)).toBe("2 products");
    expect(categoryCountLabel(0)).toBe("0 products");
  });

  it("writes the price note for both display modes", () => {
    expect(priceNote("/year")).toEqual({ excl: "/year + GST", incl: "/year incl. GST" });
    expect(priceNote("one-time")).toEqual({ excl: "one-time + GST", incl: "one-time incl. GST" });
  });

  it("puts the months of updates into the maintenance paragraph", () => {
    expect(maintenanceBody(12)).toBe(
      "One-time licenses include 12 months of updates. After that, the software keeps working on the version you have. Add a yearly maintenance plan to continue getting:",
    );
    expect(maintenanceBody(24)).toContain("include 24 months of updates");
  });

  it("takes the months of updates from the first one-time plan that sets them, else 12", () => {
    expect(oneTimeUpdatesMonths([])).toBe(DEFAULT_UPDATES_MONTHS);
    expect(oneTimeUpdatesMonths([{ plans: [plan({ type: "ANNUAL", updatesMonths: 6 })] }])).toBe(12);
    expect(
      oneTimeUpdatesMonths([
        { plans: [plan({ type: "ONE_TIME", interval: null, updatesMonths: null })] },
        { plans: [plan({ type: "ONE_TIME", interval: null, updatesMonths: 24 })] },
      ]),
    ).toBe(24);
  });

  it("picks the card's second button: free trial, else demo, else none", () => {
    const trial = product({ plans: [plan({ type: "TRIAL", pricePaise: 0, interval: null, trialDays: 15 }), plan({})] });
    expect(productSecondaryCta(trial)).toEqual({ kind: "trial", label: "Free trial", href: "/software/demo-product#plans" });
    expect(productSecondaryCta(product({}))).toEqual({
      kind: "demo",
      label: "Request demo",
      href: "/contact?type=demo&product=demo-product",
    });
    expect(productSecondaryCta(product({ demoEnabled: false }))).toBeNull();
  });
});

describe("Home with the sample catalog (fixtures)", () => {
  it("announces General Store GST Billing 5.0, as the prototype hero does", () => {
    const latest = fixtureLatestRelease();
    expect(latest).not.toBeNull();
    if (latest) expect(announcementText(latest)).toBe("General Store GST Billing 5.0 is out");
  });

  it("shows the prototype's starting prices, units and second buttons", () => {
    const cards = products.map((p) => {
      const start = startingPlan(p);
      return {
        id: p.id,
        paise: start?.pricePaise,
        note: start ? priceNote(unitLabel(start)).excl : null,
        secondary: productSecondaryCta(p)?.label ?? null,
      };
    });
    expect(cards).toEqual([
      { id: "medical-billing", paise: 499900, note: "/year + GST", secondary: "Free trial" },
      { id: "restaurant-billing", paise: 69900, note: "/month + GST", secondary: "Free trial" },
      { id: "general-store-gst", paise: 349900, note: "/year + GST", secondary: "Free trial" },
      { id: "cheque-printing", paise: 299900, note: "one-time + GST", secondary: "Request demo" },
    ]);
  });

  it("uses product and category icons from the icon registry", () => {
    for (const p of products) expect(Object.hasOwn(ICON_PATHS, p.icon)).toBe(true);
    for (const c of fixtureCategories()) expect(Object.hasOwn(ICON_PATHS, c.icon)).toBe(true);
  });

  it("has the six Home FAQs and 12 months of updates on one-time licenses", () => {
    expect(fixtureFaqs("home")).toHaveLength(6);
    expect(oneTimeUpdatesMonths(products)).toBe(12);
  });
});
