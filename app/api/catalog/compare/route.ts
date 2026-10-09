/**
 * GET /api/catalog/compare?ids=a,b,c: up to 3 PUBLISHED products side by side with their live plans and latest
 * release (api-contracts section 2). Ids are normalised like /compare (valid slugs, deduplicated, first 3 kept);
 * unknown, unpublished and coming-soon ids are dropped. 200 { ids, products }. Public and cacheable.
 */
import { CATALOG_CACHE_CONTROL, toCompareProduct } from "@/lib/checkout/catalog-api";
import { parseCompareParam } from "@/lib/compare/store";
import { json, route } from "@/lib/http";
import { getStoreProducts } from "@/lib/storefront/data";

export const runtime = "nodejs";

export const GET = route(async (req) => {
  const params = new URL(req.url).searchParams;
  const requested = parseCompareParam(params.getAll("ids").join(","));
  const products = await getStoreProducts();
  const byId = new Map(products.map((p) => [p.id, p]));
  const found = requested.flatMap((id) => {
    const p = byId.get(id);
    return p ? [toCompareProduct(p)] : [];
  });
  return json({ ids: found.map((p) => p.id), products: found }, { headers: { "cache-control": CATALOG_CACHE_CONTROL } });
});
