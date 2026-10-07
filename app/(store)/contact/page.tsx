import { JsonLd } from "@/components/seo/json-ld";
import { ContactAside } from "@/components/store/contact/contact-aside";
import { ContactView } from "@/components/store/contact/contact-view";
import { Container } from "@/components/store/container";
import { CONTACT_META, type ContactMode } from "@/content/contact";
import { breadcrumbJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { getStoreProducts, getStoreSettings } from "@/lib/storefront/data";
import { NOT_SURE_PRODUCT, preferredDateRange } from "@/lib/validation/lead";

// ?type=demo and ?product=<slug> select the mode on the server, so demo links render the demo form without a flash.
export const metadata = buildMetadata({
  title: CONTACT_META.title,
  description: CONTACT_META.description,
  path: CONTACT_META.path,
});

type SearchParams = Record<string, string | string[] | undefined>;

function firstParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value)?.trim() ?? "";
}

/**
 * /contact: contact form, or the demo request form with ?type=demo (also #demo, and ?product=<slug>, which preselects
 * a demo-enabled product and forces demo mode). Submits to POST /api/contact.
 */
export default async function ContactPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [params, settings, products] = await Promise.all([searchParams, getStoreSettings(), getStoreProducts()]);
  // The prototype lists short names ("Medical Store Billing"), as the footer does.
  const demoProducts = products.filter((p) => p.demoEnabled).map((p) => ({ id: p.id, name: p.shortName }));

  const productParam = firstParam(params.product);
  const known = productParam === NOT_SURE_PRODUCT || demoProducts.some((p) => p.id === productParam);
  const initialProduct = known ? productParam : "";
  const initialMode: ContactMode = firstParam(params.type) === "demo" || productParam !== "" ? "demo" : "contact";
  const source = initialProduct && initialProduct !== NOT_SURE_PRODUCT ? `product:${initialProduct}` : null;
  const { min, max } = preferredDateRange(new Date());

  return (
    <Container className="pb-24 pt-7 leading-[normal]">
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Contact", path: CONTACT_META.path },
        ])}
      />
      <ContactView
        initialMode={initialMode}
        initialProduct={initialProduct}
        products={demoProducts}
        dateMin={min}
        dateMax={max}
        source={source}
        aside={<ContactAside business={settings.business} />}
      />
    </Container>
  );
}
