import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InPageNav } from "@/components/store/product/in-page-nav";
import { Container } from "@/components/store/container";
import { installSteps, policyCards } from "@/components/store/product/copy";
import { productBreadcrumbs, productSections, relatedProducts, screenshotsFor } from "@/components/store/product/model";
import { PlansSection } from "@/components/store/product/plans-section";
import { ProductHero } from "@/components/store/product/product-hero";
import {
  FaqSection,
  FeaturesSection,
  InstallSection,
  RelatedSection,
  RequirementsSection,
  SupportSection,
} from "@/components/store/product/product-sections";
import { ReleasesSection } from "@/components/store/product/releases-section";
import { JsonLd } from "@/components/seo/json-ld";
import { log } from "@/lib/log";
import { breadcrumbJsonLd, softwareApplicationJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { getFaqs, getStoreProduct, getStoreProducts, getStoreSettings } from "@/lib/storefront/data";
import { productHref } from "@/lib/storefront/derive";

type ProductPageProps = { params: Promise<{ slug: string }> };

// Static per slug (no cookies or headers; prices render both GST variants). Matches STOREFRONT_REVALIDATE_SECONDS;
// admin edits also revalidate through the data layer's cache tags.
export const revalidate = 300;

/** Pre-render every published product. Slugs added later render on first request (dynamicParams). */
export async function generateStaticParams(): Promise<Array<{ slug: string }>> {
  try {
    const products = await getStoreProducts();
    return products.map((p) => ({ slug: p.id }));
  } catch (error) {
    // No catalog at build time (e.g. no database): every product page renders on demand instead.
    log.warn("product_static_params_unavailable", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

export async function generateMetadata({ params }: ProductPageProps): Promise<Metadata> {
  const { slug } = await params;
  const product = await getStoreProduct(slug);
  // Unknown, DRAFT and HIDDEN slugs: the page calls notFound() (not-found.tsx).
  if (!product) return { title: "Product not found", robots: { index: false, follow: true } };
  return buildMetadata({
    title: product.name,
    description: product.tagline,
    path: productHref(product.id),
    // app/(store)/software/[slug]/opengraph-image.tsx
    images: "segment",
  });
}

export default async function ProductPage({ params }: ProductPageProps) {
  const { slug } = await params;
  const [product, products, settings, faqs] = await Promise.all([
    getStoreProduct(slug),
    getStoreProducts(),
    getStoreSettings(),
    getFaqs(slug),
  ]);
  if (!product) notFound();

  const ratePct = settings.tax.gstRatePct;
  const crumbs = productBreadcrumbs(product);
  const sections = productSections(product, faqs.length);
  const shown = new Set(sections.map((s) => s.id));

  return (
    <div className="leading-[normal]">
      <JsonLd data={[softwareApplicationJsonLd(product), breadcrumbJsonLd(crumbs)]} />
      <ProductHero product={product} crumbs={crumbs} shots={screenshotsFor(product)} ratePct={ratePct} />
      <InPageNav sections={sections} />
      <Container>
        {shown.has("features") ? <FeaturesSection product={product} /> : null}
        {shown.has("plans") ? <PlansSection product={product} ratePct={ratePct} /> : null}
        {shown.has("requirements") ? <RequirementsSection product={product} /> : null}
        <InstallSection steps={installSteps(settings.licensing.downloadLinkMinutes)} />
        {shown.has("releases") ? <ReleasesSection product={product} /> : null}
        <SupportSection cards={policyCards(settings.business)} />
        {shown.has("faqs") ? <FaqSection faqs={faqs} /> : null}
        <RelatedSection products={relatedProducts(product, products)} ratePct={ratePct} />
      </Container>
    </div>
  );
}
