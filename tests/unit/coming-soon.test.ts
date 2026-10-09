/**
 * Coming-soon products (decisions.md 2026-10-09): status rules, the storefront data and catalog, product page model,
 * what the buy paths read, admin rules and vocabulary. Waitlist and catalog additions: tests/unit/waitlist.test.ts and
 * tests/db/catalog-additions.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { STATUS_META, statusMeta } from "@/components/admin/model";
import { COMING_SOON_CATALOG_HREF as MENU_HREF } from "@/lib/storefront/catalog-filter";
import { comingSoonLinkLabel } from "@/components/store/active-nav";
import { toCartPlanCatalog } from "@/components/store/cart/cart-model";
import { buildPricingMatrix } from "@/components/store/pricing/pricing-model";
import { COMING_SOON_COPY } from "@/components/store/product/copy";
import { comingSoonSections, relatedProducts } from "@/components/store/product/model";
import { PRODUCTS_LIST, PRODUCT_STATUS_FILTERS } from "@/lib/admin/catalog/list-config";
import { COMING_SOON_BLOCKERS, PUBLISH_BLOCKERS, productComingSoonBlockers, productPublishBlockers } from "@/lib/admin/catalog/rules";
import { isListed, isOnSale, servesExistingLicenses } from "@/lib/catalog/status";
import type * as EnvModule from "@/lib/env";
import { softwareApplicationJsonLd } from "@/lib/seo/json-ld";
import {
  activeFilterCount,
  catalogChips,
  catalogHref,
  clearCatalogFilters,
  DEFAULT_CATALOG_QUERY,
  filterCatalog,
  parseCatalogParams,
  removeCatalogChip,
  sortCatalog,
  toCatalogItem,
  type CatalogQuery,
  type CatalogSort,
} from "@/lib/storefront/catalog-filter";
import {
  getCatalogProduct,
  getCatalogProducts,
  getComingSoonProducts,
  getLatestRelease,
  getStoreProduct,
  getStoreProducts,
} from "@/lib/storefront/data";
import { fixtureComingSoonProducts, fixtureProducts } from "@/lib/storefront/fixtures";
import { parseListState } from "@/lib/url-state";

// The storefront data layer reads CATALOG_SOURCE through getEnv(): serve the fixtures (no database needed).
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  getEnv: () => ({ CATALOG_SOURCE: "fixtures" }) as unknown as EnvModule.Env,
}));

const ORIGIN = "https://axiomatic.example";
let savedAppUrl: string | undefined;
beforeAll(() => {
  savedAppUrl = process.env.APP_URL;
  process.env.APP_URL = `${ORIGIN}/`;
});
afterAll(() => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
});

const published = fixtureProducts();
const comingSoon = fixtureComingSoonProducts();
const catalog = [...published, ...comingSoon];
const items = catalog.map(toCatalogItem);
const query = (patch: Partial<CatalogQuery> = {}): CatalogQuery => ({ ...DEFAULT_CATALOG_QUERY, category: [], os: [], license: [], ...patch });

describe("product status rules", () => {
  it("sells PUBLISHED only, lists PUBLISHED and COMING_SOON, serves existing licenses for PUBLISHED and HIDDEN", () => {
    const table = ["DRAFT", "PUBLISHED", "HIDDEN", "COMING_SOON"].map((s) => [s, isOnSale(s), isListed(s), servesExistingLicenses(s)]);
    expect(table).toEqual([
      ["DRAFT", false, false, false],
      ["PUBLISHED", true, true, true],
      ["HIDDEN", false, false, true],
      ["COMING_SOON", false, true, false],
    ]);
  });
});

describe("storefront data (fixtures source)", () => {
  it("keeps everything that sells to PUBLISHED products and lists coming-soon ones after them", async () => {
    expect((await getStoreProducts()).map((p) => p.id)).toEqual(published.map((p) => p.id));
    expect((await getComingSoonProducts()).map((p) => p.id)).toEqual(comingSoon.map((p) => p.id));
    expect((await getCatalogProducts()).map((p) => p.id)).toEqual(catalog.map((p) => p.id));
    expect(await getStoreProduct("payroll")).toBeNull();
    expect(await getCatalogProduct("payroll")).toMatchObject({ id: "payroll", comingSoon: true, plans: [], releases: [] });
    expect(await getCatalogProduct("no-such-product")).toBeNull();
    expect((await getLatestRelease())?.product.id).toBe("general-store-gst");
  });
});

describe("catalog with coming-soon products", () => {
  it("lists products on sale first and coming-soon ones after them, whatever the sort", () => {
    const sorts: CatalogSort[] = ["featured", "price-asc", "price-desc", "name", "newest"];
    for (const sort of sorts) {
      const flags = sortCatalog(items, sort).map((i) => i.comingSoon);
      expect(flags, sort).toEqual([...published.map(() => false), ...comingSoon.map(() => true)]);
    }
    expect(filterCatalog(items, query()).slice(published.length).map((i) => i.id)).toEqual(comingSoon.map((p) => p.id));
    expect(filterCatalog(items, query({ sort: "name" })).slice(published.length, published.length + 2).map((i) => i.id)).toEqual([
      "agri-input-billing",
      "auto-parts-garage",
    ]);
  });

  it("shows a coming-soon card without a price, license types or a trial", () => {
    const card = items.find((i) => i.id === "jewellery-billing");
    expect(card).toMatchObject({ comingSoon: true, startingPricePaise: null, startingUnit: null, licenseTypes: [], hasTrial: false, latestReleaseAt: null });
    expect(items.find((i) => i.id === "medical-billing")?.comingSoon).toBe(false);
  });

  it("filters by availability, shows it as a chip and keeps it in the URL", () => {
    expect(filterCatalog(items, query({ availability: "coming-soon" })).map((i) => i.id)).toEqual(comingSoon.map((p) => p.id));
    expect(filterCatalog(items, query({ availability: "available" })).map((i) => i.id)).toEqual(published.map((p) => p.id));
    expect(filterCatalog(items, query({ category: ["pharmacy"] })).map((i) => i.id)).toEqual([
      "medical-billing",
      "pharma-distribution",
      "clinic-opd",
      "pathology-lab",
    ]);
    // A price, license or OS filter only matches what is sold (coming-soon products have no plans).
    expect(filterCatalog(items, query({ price: "under-3000" })).some((i) => i.comingSoon)).toBe(false);
    expect(filterCatalog(items, query({ license: ["one_time"] })).some((i) => i.comingSoon)).toBe(false);

    const q = query({ availability: "coming-soon", category: ["retail"] });
    expect(catalogHref(q)).toBe("/software?category=retail&availability=coming-soon");
    expect(parseCatalogParams(new URLSearchParams("category=retail&availability=coming-soon"), { categoryIds: ["retail"] })).toEqual(q);
    expect(parseCatalogParams(new URLSearchParams("availability=soon"))).toEqual(query());
    expect(activeFilterCount(q)).toBe(2);
    const chips = catalogChips(q, [{ id: "retail", name: "Retail & Grocery" }]);
    expect(chips.map((c) => c.label)).toEqual(["Retail & Grocery", "Coming soon"]);
    const chip = chips.find((c) => c.facet === "availability");
    expect(chip && removeCatalogChip(q, chip).availability).toBe("all");
    expect(clearCatalogFilters({ ...q, sort: "name" })).toEqual(query({ sort: "name" }));
  });

  it("links the header menu to the coming-soon view of the catalog", () => {
    expect(MENU_HREF).toBe("/software?availability=coming-soon");
    expect(parseCatalogParams(new URL(`https://x${MENU_HREF}`).searchParams).availability).toBe("coming-soon");
    expect(comingSoonLinkLabel(20)).toBe("20 more coming soon");
  });
});

describe("what the buy paths read", () => {
  const root = process.cwd();
  const source = (path: string) => readFileSync(join(root, path), "utf8");

  it("home, pricing, compare, cart, checkout and the demo form read only products on sale", () => {
    for (const path of [
      "app/(store)/page.tsx",
      "app/(store)/pricing/page.tsx",
      "app/(store)/compare/page.tsx",
      "app/(store)/cart/page.tsx",
      "app/(checkout)/checkout/page.tsx",
      "app/(store)/contact/page.tsx",
      "app/api/catalog/compare/route.ts",
    ]) {
      const text = source(path);
      expect(text, path).toContain("getStoreProducts");
      expect(text, path).not.toMatch(/getCatalogProducts|getComingSoonProducts|getCatalogProduct\b/);
    }
  });

  it("builds no pricing row or cart plan for a coming-soon product", async () => {
    const ids = new Set(comingSoon.map((p) => p.id));
    expect(buildPricingMatrix(await getStoreProducts()).map((row) => row.id)).toEqual(published.map((p) => p.id));
    // Even handed the whole catalog, the cart finds no plan of a coming-soon product (it has none).
    for (const plan of Object.values(toCartPlanCatalog(catalog))) expect(ids.has(plan.productSlug)).toBe(false);
  });
});

describe("coming-soon product page model", () => {
  const payroll = comingSoon.find((p) => p.id === "payroll");
  if (!payroll) throw new Error("payroll fixture missing");

  it("shows planned features and requirements (and FAQs when there are some), never plans, installation or releases", () => {
    expect(comingSoonSections(payroll, 0).map((s) => s.id)).toEqual(["features", "requirements"]);
    expect(comingSoonSections(payroll, 2).map((s) => s.id)).toEqual(["features", "requirements", "faqs"]);
  });

  it("relates to published and coming-soon products in the admin's order", () => {
    const clinic = comingSoon.find((p) => p.id === "clinic-opd");
    expect(clinic && relatedProducts(clinic, catalog).map((p) => [p.id, p.comingSoon])).toEqual([
      ["pathology-lab", true],
      ["medical-billing", false],
    ]);
  });

  it("describes the product in JSON-LD without offers, and says coming soon in the title and description", () => {
    const ld = softwareApplicationJsonLd(payroll);
    expect(ld).toMatchObject({ "@type": "SoftwareApplication", name: payroll.name, url: `${ORIGIN}/software/payroll` });
    expect(ld).not.toHaveProperty("offers");
    expect(ld).not.toHaveProperty("softwareVersion");
    expect(COMING_SOON_COPY.metaTitle(payroll.name)).toBe("Payroll & Attendance Software (coming soon)");
    expect(COMING_SOON_COPY.metaDescription(payroll.tagline)).toMatch(/^Coming soon: /);
    expect(COMING_SOON_COPY.sentBody(payroll.name)).toBe("Thanks — we’ll email you when Payroll & Attendance Software launches.");
  });
});

describe("admin: coming-soon status", () => {
  const ready = { status: "DRAFT", name: "Payroll", tagline: "Salaries", summary: "Payroll software.", categoryId: "finance", icon: "badge", contentValid: true, hasLicenses: false, hasOrders: false };

  it("needs the storefront copy but no plans or releases to mark a product coming soon", () => {
    expect(productComingSoonBlockers(ready)).toEqual([]);
    expect(productComingSoonBlockers({ ...ready, status: "HIDDEN" })).toEqual([]);
    expect(productComingSoonBlockers({ ...ready, contentValid: false, tagline: " " })).toEqual([COMING_SOON_BLOCKERS.tagline, COMING_SOON_BLOCKERS.content]);
    expect(productComingSoonBlockers({ ...ready, hasLicenses: true })).toEqual([COMING_SOON_BLOCKERS.licensed]);
    // An order (even unpaid) could still be captured and issue a license: such a product is hidden instead.
    expect(productComingSoonBlockers({ ...ready, hasOrders: true })).toEqual([COMING_SOON_BLOCKERS.ordered]);
    expect(productComingSoonBlockers({ ...ready, hasLicenses: true, hasOrders: true })).toEqual([COMING_SOON_BLOCKERS.licensed]);
    expect(productComingSoonBlockers({ ...ready, status: "PUBLISHED" })).toEqual([COMING_SOON_BLOCKERS.status]);
  });

  it("still needs a plan on sale and a published release to publish", () => {
    expect(productPublishBlockers({ contentValid: true, mainPlansOnSale: 0, publishedStableReleases: 0 })).toEqual([PUBLISH_BLOCKERS.plan, PUBLISH_BLOCKERS.release]);
  });

  it("filters and labels the status", () => {
    expect(PRODUCT_STATUS_FILTERS).toContain("coming_soon");
    expect(parseListState(new URLSearchParams("filter[status]=coming_soon"), PRODUCTS_LIST).filters.status).toBe("coming_soon");
    expect(statusMeta("product", "COMING_SOON")).toEqual({ label: "Coming soon", tone: "lavender" });
    expect(STATUS_META.product.coming_soon.label).toBe("Coming soon");
  });
});
