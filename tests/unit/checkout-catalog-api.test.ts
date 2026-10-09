import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { fixtureCategories, fixtureComingSoonProducts, fixtureProducts } from "@/lib/storefront/fixtures";

const catalog = () => [...fixtureProducts(), ...fixtureComingSoonProducts()];

vi.mock("@/lib/storefront/data", () => ({
  getStoreProducts: async () => fixtureProducts(),
  getCatalogProducts: async () => catalog(),
  getStoreCategories: async () => fixtureCategories(),
  getStoreProduct: async (slug: string) => fixtureProducts().find((p) => p.id === slug) ?? null,
  getCatalogProduct: async (slug: string) => catalog().find((p) => p.id === slug) ?? null,
}));

const { GET: listProducts } = await import("@/app/api/catalog/products/route");
const { GET: getProduct } = await import("@/app/api/catalog/products/[slug]/route");
const { GET: compare } = await import("@/app/api/catalog/compare/route");

const req = (path: string) => new NextRequest(`http://localhost:3000${path}`);
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });

describe("GET /api/catalog/products", () => {
  it("returns cards, facets and the parsed query, cacheable", async () => {
    const res = await listProducts(req("/api/catalog/products?category=pharmacy,nope&sort=price-asc&os=windows"), undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/^public, /);
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
      facets: { category: Array<{ value: string; checked: boolean }> };
      query: { category: string[]; sort: string };
      total: number;
    };
    expect(body.query).toMatchObject({ category: ["pharmacy"], sort: "price-asc" });
    expect(body.total).toBe(body.items.length);
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(item.categoryId).toBe("pharmacy");
      expect(item).not.toHaveProperty("searchText");
    }
    expect(body.facets.category.find((c) => c.value === "pharmacy")?.checked).toBe(true);
  });

  it("returns every published product, then every coming-soon product, without filters", async () => {
    const body = (await (await listProducts(req("/api/catalog/products"), undefined)).json()) as {
      total: number;
      items: Array<{ id: string; comingSoon: boolean; startingPricePaise: number | null; licenseTypes: string[] }>;
    };
    expect(body.total).toBe(fixtureProducts().length + fixtureComingSoonProducts().length);
    expect(body.items.map((i) => i.id)).toEqual(catalog().map((p) => p.id));
    for (const item of body.items.slice(fixtureProducts().length)) {
      expect(item).toMatchObject({ comingSoon: true, startingPricePaise: null, licenseTypes: [] });
    }
  });

  it("filters by availability", async () => {
    const coming = (await (await listProducts(req("/api/catalog/products?availability=coming-soon"), undefined)).json()) as {
      items: Array<{ id: string }>;
      query: { availability: string };
    };
    expect(coming.query.availability).toBe("coming-soon");
    expect(coming.items.map((i) => i.id)).toEqual(fixtureComingSoonProducts().map((p) => p.id));
    const now = (await (await listProducts(req("/api/catalog/products?availability=available"), undefined)).json()) as { items: Array<{ id: string }> };
    expect(now.items.map((i) => i.id)).toEqual(fixtureProducts().map((p) => p.id));
  });
});

describe("GET /api/catalog/products/:slug", () => {
  it("returns the product with plans, latest release notes, FAQs and related cards", async () => {
    const slug = fixtureProducts()[0]?.id ?? "";
    const res = await getProduct(req(`/api/catalog/products/${slug}`), ctx(slug));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { product: Record<string, unknown>; related: unknown[] };
    expect(Object.keys(body).sort()).toEqual(["faqs", "latestRelease", "plans", "product", "related"]);
    expect(body.product.id).toBe(slug);
    expect(body.product).not.toHaveProperty("plans");
    expect(body.latestRelease === null || Object.keys(body.latestRelease as object).sort().join() === "notes,releasedAt,version").toBe(true);
  });

  it("returns a coming-soon product without plans or a release, with its related cards", async () => {
    const res = await getProduct(req("/api/catalog/products/pharma-distribution"), ctx("pharma-distribution"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { product: Record<string, unknown>; plans: unknown[]; latestRelease: unknown; related: Array<{ id: string; comingSoon: boolean }> };
    expect(body.product).toMatchObject({ id: "pharma-distribution", comingSoon: true, demoEnabled: false });
    expect(body.plans).toEqual([]);
    expect(body.latestRelease).toBeNull();
    expect(body.related.map((r) => [r.id, r.comingSoon])).toEqual([
      ["medical-billing", false],
      ["fmcg-distribution", true],
    ]);
  });

  it("answers 404 for unknown and malformed slugs", async () => {
    for (const slug of ["no-such-product", "../etc", "UPPER"]) {
      const res = await getProduct(req(`/api/catalog/products/x`), ctx(slug));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: "Product not found." } });
    }
  });
});

describe("GET /api/catalog/compare", () => {
  it("keeps the first three valid ids and drops unknown ones", async () => {
    const ids = fixtureProducts().map((p) => p.id);
    const res = await compare(req(`/api/catalog/compare?ids=${ids[0]},nope,${ids[1]},${ids[2]}`), undefined);
    const body = (await res.json()) as { ids: string[]; products: Array<{ id: string; plans: unknown[] }> };
    expect(body.ids).toEqual([ids[0], ids[1]]);
    expect(body.products.map((p) => p.id)).toEqual([ids[0], ids[1]]);
    expect(body.products[0]?.plans.length).toBeGreaterThan(0);
    expect((await (await compare(req("/api/catalog/compare"), undefined)).json()) as unknown).toEqual({ ids: [], products: [] });
  });

  it("drops coming-soon products (they are not sold)", async () => {
    const res = await compare(req("/api/catalog/compare?ids=payroll,medical-billing,clinic-opd"), undefined);
    const body = (await res.json()) as { ids: string[] };
    expect(body.ids).toEqual(["medical-billing"]);
  });
});
