import type { MetadataRoute } from "next";
import { DOC_GUIDES, guideHref } from "@/content/docs/guides";
import { LEGAL_DOCUMENTS, LEGAL_DOC_SLUGS, legalDocHref } from "@/content/legal/documents";
import { startOfDayIST } from "@/lib/dates";
import { siteUrl } from "@/lib/seo/metadata";
import { getStoreProducts } from "@/lib/storefront/data";
import { latestRelease, productHref } from "@/lib/storefront/derive";

/**
 * sitemap.xml: the public storefront pages, every PUBLISHED product (lastModified = its newest published release),
 * every docs guide and every legal document (lastModified = the document's "Last updated" date). Absolute URLs from
 * APP_URL. Left out: /docs and /legal (they redirect), /compare and filtered catalog URLs (noindex / canonical
 * /software), sign-in and every private area (robots.txt disallows them). Revalidates with the catalog cache.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const products = await getStoreProducts();
  const page = (path: string): MetadataRoute.Sitemap[number] => ({ url: siteUrl(path) });

  return [
    page("/"),
    page("/software"),
    ...products.map((product) => {
      const release = latestRelease(product);
      return { url: siteUrl(productHref(product.id)), ...(release ? { lastModified: release.releasedAt } : {}) };
    }),
    page("/pricing"),
    page("/about"),
    page("/contact"),
    page("/support"),
    ...DOC_GUIDES.map((guide) => page(guideHref(guide.slug))),
    ...LEGAL_DOC_SLUGS.map((slug) => ({
      url: siteUrl(legalDocHref(slug)),
      lastModified: startOfDayIST(LEGAL_DOCUMENTS[slug].lastUpdated),
    })),
  ];
}
