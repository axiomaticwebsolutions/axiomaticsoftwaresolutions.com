import { CatalogIntro } from "@/components/store/catalog/catalog-intro";
import { CatalogView } from "@/components/store/catalog/catalog-view";
import { Container } from "@/components/store/container";
import { JsonLd } from "@/components/seo/json-ld";
import { breadcrumbJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { CATALOG_PATH, parseCatalogParams, toCatalogItem } from "@/lib/storefront/catalog-filter";
import { getStoreCategories, getStoreProducts, getStoreSettings } from "@/lib/storefront/data";

// Filtered views (/software?category=...) all canonicalise to /software (docs/decisions.md).
export const metadata = buildMetadata({
  title: "Software",
  description:
    "Browse billing, GST invoicing and cheque printing software. Filter by business type, price, operating system and license type.",
  path: CATALOG_PATH,
});

type SoftwarePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * /software: the catalog. The server reads the filters from the URL and renders the matching results (no-JS and
 * crawlers see real content); CatalogView takes over on the client for live filtering, the drawer and compare.
 */
export default async function SoftwarePage({ searchParams }: SoftwarePageProps) {
  const [params, products, categories, settings] = await Promise.all([
    searchParams,
    getStoreProducts(),
    getStoreCategories(),
    getStoreSettings(),
  ]);
  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name }));
  const initialQuery = parseCatalogParams(params, { categoryIds: categoryOptions.map((c) => c.id) });
  const ratePct = settings.tax.gstRatePct;

  return (
    <Container className="pb-[120px] pt-7 leading-[normal]">
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Software", path: CATALOG_PATH },
        ])}
      />
      <CatalogIntro ratePct={ratePct} />
      <CatalogView
        items={products.map(toCatalogItem)}
        categories={categoryOptions}
        initialQuery={initialQuery}
        ratePct={ratePct}
      />
    </Container>
  );
}
