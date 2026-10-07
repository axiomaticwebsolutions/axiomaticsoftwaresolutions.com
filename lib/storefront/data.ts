/**
 * Storefront data access for Server Components, route handlers and metadata. Server-only.
 *
 * Source (env CATALOG_SOURCE): "db" (default) reads PostgreSQL through prisma-source.ts, cached across requests with
 * unstable_cache (revalidate 300 s, tags STOREFRONT_TAGS so admin edits can call revalidateTag()); "fixtures" (dev and
 * test only) serves the SAMPLE seed data uncached, so pages render without a database. React cache() dedupes calls
 * within one request either way. Values are plain JSON (ISO date strings).
 */
import "server-only";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { newestRelease } from "./derive";
import { fixtureCategories, fixtureFaqs, fixtureProducts, fixtureSettings } from "./fixtures";
import { loadFaqs, loadStoreCategories, loadStoreProducts, loadStoreSettings } from "./prisma-source";
import type { StoreCategory, StoreFaq, StoreLatestRelease, StoreProduct, StoreSettings } from "./types";

/**
 * Cache tags. Admin writes call revalidateTag(): `catalog` after category, product, plan or release edits, `faqs`
 * after FAQ edits, `settings` after settings edits.
 */
export const STOREFRONT_TAGS = { catalog: "catalog", faqs: "faqs", settings: "settings" } as const;

export const STOREFRONT_REVALIDATE_SECONDS = 300;

function fromFixtures(): boolean {
  return getEnv().CATALOG_SOURCE === "fixtures";
}

const cachedSettings = unstable_cache(() => loadStoreSettings(db), ["storefront", "settings"], {
  tags: [STOREFRONT_TAGS.settings],
  revalidate: STOREFRONT_REVALIDATE_SECONDS,
});

const cachedCategories = unstable_cache(() => loadStoreCategories(db), ["storefront", "categories"], {
  tags: [STOREFRONT_TAGS.catalog],
  revalidate: STOREFRONT_REVALIDATE_SECONDS,
});

// Products carry their FAQs, so FAQ edits revalidate them too.
const cachedProducts = unstable_cache(() => loadStoreProducts(db), ["storefront", "products"], {
  tags: [STOREFRONT_TAGS.catalog, STOREFRONT_TAGS.faqs],
  revalidate: STOREFRONT_REVALIDATE_SECONDS,
});

// The page argument is part of the cache key.
const cachedFaqs = unstable_cache((page: string) => loadFaqs(db, page), ["storefront", "faqs"], {
  tags: [STOREFRONT_TAGS.faqs],
  revalidate: STOREFRONT_REVALIDATE_SECONDS,
});

/** Site settings (business, tax, licensing, banner, sample notice) with defaults filled in. */
export const getStoreSettings = cache(
  async (): Promise<StoreSettings> => (fromFixtures() ? fixtureSettings() : cachedSettings()),
);

/** Categories by sortOrder, with PUBLISHED product counts. */
export const getStoreCategories = cache(
  async (): Promise<StoreCategory[]> => (fromFixtures() ? fixtureCategories() : cachedCategories()),
);

/** PUBLISHED products by rank, with live plans, published releases (newest first) and FAQs. */
export const getStoreProducts = cache(
  async (): Promise<StoreProduct[]> => (fromFixtures() ? fixtureProducts() : cachedProducts()),
);

/** One PUBLISHED product, or null for DRAFT, HIDDEN and unknown slugs (the page calls notFound()). */
export const getStoreProduct = cache(async (slug: string): Promise<StoreProduct | null> => {
  const products = await getStoreProducts();
  return products.find((p) => p.id === slug) ?? null;
});

/** Published FAQs for "home", "pricing", "support" or a product slug, by sortOrder. */
export const getFaqs = cache(
  async (page: string): Promise<StoreFaq[]> => (fromFixtures() ? fixtureFaqs(page) : cachedFaqs(page)),
);

/** The newest published release of any published product (Home hero announcement), or null. */
export const getLatestRelease = cache(
  async (): Promise<StoreLatestRelease | null> => newestRelease(await getStoreProducts()),
);
