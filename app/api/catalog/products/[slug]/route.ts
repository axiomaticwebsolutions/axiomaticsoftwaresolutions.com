/**
 * GET /api/catalog/products/:slug: one listed product with its live plans, latest release (notes only), FAQs and
 * related products (api-contracts section 2). A COMING_SOON product has `comingSoon: true`, no plans and no release.
 * 404 for DRAFT, HIDDEN and unknown slugs. Public and cacheable.
 */
import { CATALOG_CACHE_CONTROL, toCatalogCard, toLatestRelease, toProductView, type CatalogProductDetail } from "@/lib/checkout/catalog-api";
import { errors, json, route } from "@/lib/http";
import { toCatalogItem } from "@/lib/storefront/catalog-filter";
import { getCatalogProduct, getCatalogProducts } from "@/lib/storefront/data";

export const runtime = "nodejs";

type Context = { params: Promise<{ slug: string }> };

export const GET = route<Context>(async (_req, { params }) => {
  const { slug } = await params;
  const product = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? await getCatalogProduct(slug) : null;
  if (!product) throw errors.notFound("Product");
  const products = await getCatalogProducts();
  const byId = new Map(products.map((p) => [p.id, p]));
  const related = product.relatedIds.flatMap((id) => {
    const p = byId.get(id);
    return p ? [toCatalogCard(toCatalogItem(p))] : [];
  });
  const body: CatalogProductDetail = {
    product: toProductView(product),
    plans: product.plans,
    latestRelease: toLatestRelease(product),
    faqs: product.faqs,
    related,
  };
  return json(body, { headers: { "cache-control": CATALOG_CACHE_CONTROL } });
});
