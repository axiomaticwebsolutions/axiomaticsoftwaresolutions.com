/**
 * Public catalog API views (docs/api-contracts.md section 2): thin, read-only mappings over lib/storefront/data so the
 * JSON matches what the storefront pages render. Only listed products (PUBLISHED, and COMING_SOON ones with no plans
 * or releases in the catalog and product routes; compare is PUBLISHED only), live plans and published releases/FAQs.
 */
import type { CatalogItem } from "@/lib/storefront/catalog-filter";
import { latestRelease } from "@/lib/storefront/derive";
import type { StoreFaq, StorePlan, StoreProduct } from "@/lib/storefront/types";

/** Shared, cacheable responses: browsers 60 s, CDN 5 minutes (the data layer revalidates every 300 s). */
export const CATALOG_CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

export type CatalogCard = Omit<CatalogItem, "searchText">;

export type CatalogProductView = Omit<StoreProduct, "plans" | "releases" | "faqs">;

export type CatalogLatestRelease = { version: string; releasedAt: string; notes: string[] } | null;

export type CatalogProductDetail = {
  product: CatalogProductView;
  plans: StorePlan[];
  latestRelease: CatalogLatestRelease;
  faqs: StoreFaq[];
  related: CatalogCard[];
};

export type CompareProduct = CatalogProductView & { plans: StorePlan[]; latestRelease: CatalogLatestRelease };

export function toCatalogCard(item: CatalogItem): CatalogCard {
  const { searchText: _searchText, ...card } = item;
  return card;
}

export function toProductView(p: StoreProduct): CatalogProductView {
  const { plans: _plans, releases: _releases, faqs: _faqs, ...view } = p;
  return view;
}

/** The newest published release, notes only (no file details). */
export function toLatestRelease(p: StoreProduct): CatalogLatestRelease {
  const release = latestRelease(p);
  return release ? { version: release.version, releasedAt: release.releasedAt, notes: [...release.notes] } : null;
}

export function toCompareProduct(p: StoreProduct): CompareProduct {
  return { ...toProductView(p), plans: p.plans, latestRelease: toLatestRelease(p) };
}
