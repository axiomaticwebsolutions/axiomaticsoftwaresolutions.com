/**
 * GET /api/catalog/products?q=&category=&os=&license=&price=&sort=: the software catalog (api-contracts section 2).
 * Same query rules as /software (lib/storefront/catalog-filter.ts): unknown values fall back to the defaults.
 * 200 { items: ProductCard[], facets, query, total }. Public and cacheable.
 */
import { CATALOG_CACHE_CONTROL, toCatalogCard } from "@/lib/checkout/catalog-api";
import { json, route } from "@/lib/http";
import { catalogFacets, filterCatalog, parseCatalogParams, toCatalogItem } from "@/lib/storefront/catalog-filter";
import { getStoreCategories, getStoreProducts } from "@/lib/storefront/data";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const [products, categories] = await Promise.all([getStoreProducts(), getStoreCategories()]);
  const options = categories.map((c) => ({ id: c.id, name: c.name }));
  const query = parseCatalogParams(new URL(req.url).searchParams, { categoryIds: options.map((c) => c.id) });
  const all = products.map(toCatalogItem);
  const items = filterCatalog(all, query).map(toCatalogCard);
  return json(
    { items, facets: catalogFacets(all, query, options), query, total: items.length },
    { headers: { "cache-control": CATALOG_CACHE_CONTROL } },
  );
});
