import { describe, expect, it } from "vitest";
import { SETTING_KEYS } from "@/lib/config";
import type { Db } from "@/lib/db";
import {
  fixtureCatalogProduct,
  fixtureCategories,
  fixtureComingSoonProducts,
  fixtureFaqs,
  fixtureLatestRelease,
  fixtureProduct,
  fixtureProducts,
  fixtureSettings,
} from "@/lib/storefront/fixtures";
import { loadCatalogProducts, loadFaqs, loadStoreCategories, loadStoreProducts } from "@/lib/storefront/prisma-source";
import { COMING_SOON_PRODUCTS, PRODUCTS } from "@/prisma/seed-data/catalog";
import { buildSeedPlan } from "@/prisma/seed-data/plan";

const products = fixtureProducts();

describe("fixtures source", () => {
  it("serves the 4 sample products by rank, all published, as plain JSON", () => {
    expect(products.map((p) => p.id)).toEqual(["medical-billing", "restaurant-billing", "general-store-gst", "cheque-printing"]);
    expect(products.map((p) => p.rank)).toEqual([1, 2, 3, 4]);
    expect(products).toHaveLength(PRODUCTS.length);
    expect(JSON.parse(JSON.stringify(products))).toEqual(products);
    const med = products[0];
    expect(med).toMatchObject({
      code: "MED",
      shortName: "Medical Store Billing",
      tone: "sage",
      category: { id: "pharmacy", name: "Medical & Pharmacy", tone: "sage", icon: "local_pharmacy" },
      platforms: ["windows"],
      demoEnabled: true,
      comingSoon: false,
      relatedIds: ["general-store-gst", "cheque-printing"],
      createdAt: "2024-02-09T18:30:00.000Z",
    });
    expect(med?.content.features).toHaveLength(6);
  });

  it("sorts plans by sortOrder and keeps every plan field", () => {
    for (const p of products) {
      expect(p.plans.map((x) => x.sortOrder)).toEqual(p.plans.map((_, i) => i));
      for (const plan of p.plans) expect(plan.productId).toBe(p.id);
    }
    expect(fixtureProduct("restaurant-billing")?.plans.map((p) => p.id)).toEqual(["rst-trial", "rst-monthly", "rst-yearly"]);
    expect(fixtureProduct("restaurant-billing")?.plans[1]).toEqual({
      id: "rst-monthly",
      productId: "restaurant-billing",
      type: "SUBSCRIPTION",
      name: "Monthly subscription",
      summary: "Billed every month per terminal. Renew from your account; nothing is charged automatically.",
      includes: ["Per terminal", "All updates", "Standard support", "No automatic charges"],
      pricePaise: 69900,
      interval: "MONTH",
      trialDays: null,
      deviceLimit: 1,
      perUnit: "terminal",
      maxQty: 10,
      multiDevice: false,
      updatesMonths: null,
      popular: false,
      sortOrder: 1,
    });
  });

  it("lists releases newest first with size labels and platforms", () => {
    for (const p of products) {
      const dates = p.releases.map((r) => r.releasedAt);
      expect(dates).toEqual([...dates].sort().reverse());
    }
    expect(fixtureProduct("medical-billing")?.releases[0]).toEqual({
      version: "4.2.1",
      releasedAt: "2026-09-14T18:30:00.000Z",
      notes: ["Faster search by salt name", "Near-expiry return report", "Fixed thermal print cut-off on some 3-inch printers"],
      sizeLabel: "148 MB",
      platforms: ["windows"],
    });
    expect(fixtureProduct("restaurant-billing")?.releases[0]?.platforms).toEqual(["windows", "android"]);
    expect(fixtureLatestRelease()).toMatchObject({ product: { id: "general-store-gst" }, release: { version: "5.0.2" } });
  });

  it("returns null for unknown slugs and fresh objects on every call", () => {
    expect(fixtureProduct("nope")).toBeNull();
    const a = fixtureProduct("cheque-printing");
    a?.plans.pop();
    expect(fixtureProduct("cheque-printing")?.plans).toHaveLength(3);
  });

  it("serves the FAQ sets per page", () => {
    expect(fixtureFaqs("home")).toHaveLength(6);
    expect(fixtureFaqs("pricing")).toHaveLength(6);
    const support = fixtureFaqs("support");
    expect(support).toHaveLength(7);
    expect(support[0]).toEqual({
      id: "seed_faq_support_1",
      question: "It says “activation limit reached”.",
      answer: "All device slots on the license are in use. Deactivate a computer from your account or add one.",
      href: "/docs/activate",
    });
    expect(fixtureFaqs("home").every((f) => f.href === null)).toBe(true);
    expect(fixtureFaqs("medical-billing").map((f) => f.question)).toEqual([
      "Can I import my existing medicine list?",
      "Does it work without internet?",
      "What happens when an annual license ends?",
    ]);
    expect(fixtureProduct("medical-billing")?.faqs).toEqual(fixtureFaqs("medical-billing"));
    expect(fixtureFaqs("unknown")).toEqual([]);
    expect(fixtureFaqs("constructor")).toEqual([]);
  });

  it("serves categories with blurbs, published and coming-soon product counts", () => {
    expect(fixtureCategories()).toEqual([
      { id: "pharmacy", name: "Medical & Pharmacy", blurb: "Billing with batch and expiry tracking for chemists and medical stores.", tone: "sage", icon: "local_pharmacy", sortOrder: 0, productCount: 1, comingSoonCount: 3 },
      { id: "restaurant", name: "Restaurants & Cafés", blurb: "Table billing, KOTs and day-end reports for food businesses.", tone: "peach", icon: "room_service", sortOrder: 1, productCount: 1, comingSoonCount: 1 },
      { id: "retail", name: "Retail & Grocery", blurb: "GST invoicing, barcode billing and stock for general stores.", tone: "blue", icon: "shopping_basket", sortOrder: 2, productCount: 1, comingSoonCount: 6 },
      { id: "finance", name: "Finance & Office", blurb: "Cheque printing and payment records for any business.", tone: "lavender", icon: "account_balance", sortOrder: 3, productCount: 1, comingSoonCount: 3 },
      { id: "jewellery", name: "Jewellery", blurb: "Billing with daily gold rates, HUID and tags for jewellers.", tone: "pink", icon: "workspace_premium", sortOrder: 4, productCount: 0, comingSoonCount: 1 },
      { id: "wholesale", name: "Wholesale & Distribution", blurb: "Billing, schemes and collections for distributors, stockists and traders.", tone: "peach", icon: "warehouse", sortOrder: 5, productCount: 0, comingSoonCount: 3 },
      { id: "industry", name: "Manufacturing & Logistics", blurb: "Software for factories, transporters and fuel stations.", tone: "blue", icon: "factory", sortOrder: 6, productCount: 0, comingSoonCount: 3 },
    ]);
  });

  it("serves the coming-soon products by rank, after the published ones, with no plans, releases or FAQs", () => {
    const coming = fixtureComingSoonProducts();
    expect(coming.map((p) => p.id)).toEqual(COMING_SOON_PRODUCTS.map((p) => p.id));
    expect(coming.every((p) => p.comingSoon && p.plans.length === 0 && p.releases.length === 0 && p.faqs.length === 0)).toBe(true);
    expect(coming.every((p) => !p.demoEnabled)).toBe(true);
    expect(Math.min(...coming.map((p) => p.rank))).toBeGreaterThan(Math.max(...products.map((p) => p.rank)));
    expect(products.some((p) => p.comingSoon)).toBe(false);
    expect(fixtureCatalogProduct("payroll")).toMatchObject({
      code: "PAY",
      tone: "lavender",
      comingSoon: true,
      category: { id: "finance", tone: "lavender" },
      relatedIds: ["cheque-printing"],
      createdAt: "2026-10-08T18:30:00.000Z",
    });
    expect(fixtureProduct("payroll")).toBeNull();
    expect(fixtureCatalogProduct("medical-billing")).toEqual(fixtureProduct("medical-billing"));
    expect(fixtureCatalogProduct("nope")).toBeNull();
    expect(fixtureFaqs("payroll")).toEqual([]);
  });

  it("serves the seed settings", () => {
    const settings = fixtureSettings();
    expect(Object.keys(settings)).toEqual([...SETTING_KEYS]);
    expect(settings.business.salesEmail).toBe("sales@axiomatic.example");
    expect(settings.tax.priceDisplay).toBe("exclusive");
    expect(settings["content.sampleNotice"].enabled).toBe(true);
  });
});

/**
 * The database source must read back exactly what the fixtures serve: rows shaped like the seed writes them
 * (buildSeedPlan), run through prisma-source with a fake client that applies the where/orderBy the real query asks for.
 */
describe("database source parity", () => {
  const seed = buildSeedPlan({ now: new Date("2026-10-06T06:30:00.000Z"), ownerEmail: "owner@axiomatic.example" });
  const calls: { model: string; args: unknown }[] = [];

  const productRows = [...seed.products]
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
    .map((p) => ({
      ...p,
      updatedAt: p.createdAt,
      category: seed.categories.find((c) => c.id === p.categoryId),
      plans: seed.plans.filter((x) => x.productId === p.id && !x.archived).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
      releases: seed.releases
        .filter((r) => r.productId === p.id)
        .map((r) => ({
          ...r,
          files: seed.releaseFiles.filter((f) => f.releaseId === r.id).map((f) => ({ platform: f.platform, sizeBytes: f.sizeBytes })),
        })),
    }));

  const fakeDb = {
    product: {
      findMany: async (args: unknown) => {
        calls.push({ model: "product", args });
        return productRows;
      },
      groupBy: async (args: unknown) => {
        calls.push({ model: "productGroups", args });
        const groups = new Map<string, { categoryId: string; status: string; _count: { _all: number } }>();
        for (const p of seed.products) {
          const key = `${p.categoryId}:${String(p.status)}`;
          const g = groups.get(key) ?? { categoryId: p.categoryId, status: String(p.status), _count: { _all: 0 } };
          g._count._all += 1;
          groups.set(key, g);
        }
        return [...groups.values()];
      },
    },
    category: {
      findMany: async (args: unknown) => {
        calls.push({ model: "category", args });
        return seed.categories;
      },
    },
    faq: {
      findMany: async (args: { where: { page: string | { in: string[] } } }) => {
        calls.push({ model: "faq", args });
        const page = args.where.page;
        const pages = typeof page === "string" ? [page] : page.in;
        return seed.faqs
          .filter((f) => pages.includes(f.page) && f.published)
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
      },
    },
  } as unknown as Db;

  it("maps products, plans, releases (BigInt sizes) and FAQs to the same view", async () => {
    const fromDb = await loadStoreProducts(fakeDb);
    expect(fromDb).toEqual(products);
    const productQuery = calls.find((c) => c.model === "product")?.args as Record<string, unknown>;
    expect(productQuery).toMatchObject({
      where: { status: { in: ["PUBLISHED", "COMING_SOON"] } },
      orderBy: [{ rank: "asc" }, { name: "asc" }],
      include: { plans: { where: { archived: false } }, releases: { where: { status: "PUBLISHED" } } },
    });
  });

  it("maps coming-soon products to the same view, without plans or releases", async () => {
    const { published, comingSoon } = await loadCatalogProducts(fakeDb);
    expect(published).toEqual(products);
    expect(comingSoon).toEqual(fixtureComingSoonProducts());
  });

  it("maps categories and FAQ pages to the same view", async () => {
    expect(await loadStoreCategories(fakeDb)).toEqual(fixtureCategories());
    const groupQuery = calls.find((c) => c.model === "productGroups")?.args;
    expect(groupQuery).toMatchObject({ by: ["categoryId", "status"], where: { status: { in: ["PUBLISHED", "COMING_SOON"] } } });
    for (const page of ["home", "pricing", "support", "general-store-gst"]) {
      expect(await loadFaqs(fakeDb, page)).toEqual(fixtureFaqs(page));
    }
    expect(calls.filter((c) => c.model === "faq").every((c) => (c.args as { where: { published: boolean } }).where.published)).toBe(true);
  });
});
