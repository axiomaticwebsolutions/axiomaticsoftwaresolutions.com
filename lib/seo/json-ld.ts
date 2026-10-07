/**
 * schema.org JSON-LD builders (docs/decisions.md > Phase 2: Organization on home and about, SoftwareApplication with
 * one Offer per purchasable plan in INR excluding GST, BreadcrumbList on product pages, FAQPage on pricing and
 * support). Render with components/seo/json-ld.tsx, which escapes the output for a <script> element.
 */
import type { BusinessSettings } from "@/lib/config";
import { paiseToDecimalString } from "@/lib/money";
import { latestRelease, mainPlans, platformsLabel, productHref } from "@/lib/storefront/derive";
import type { StoreFaq, StorePlan, StoreProduct } from "@/lib/storefront/types";
import { SITE_NAME, siteUrl } from "./metadata";

export type JsonLdValue = string | number | boolean | null | JsonLdValue[] | { [key: string]: JsonLdValue };
export type JsonLdObject = { [key: string]: JsonLdValue };

const CONTEXT = "https://schema.org";

export function organizationId(): string {
  return siteUrl("/#organization");
}

export type OrganizationBusiness = Pick<BusinessSettings, "legalName" | "sample" | "supportEmail" | "phone">;

/**
 * Organization name for JSON-LD: the brand name while the seller details are placeholders (business.sample; the default
 * legal name reads "… (placeholder)"), the registered legal name once they are real.
 */
export function organizationName(business: Pick<BusinessSettings, "legalName" | "sample">): string {
  const legalName = business.legalName.trim();
  return business.sample || !legalName ? SITE_NAME : legalName;
}

/**
 * The company, from settings.business. Every page that publishes it (home, about) calls this with the settings as
 * they are, so one @id always carries one name. While the details are placeholders the telephone (a zero
 * placeholder) is left out.
 */
export function organizationJsonLd(business: OrganizationBusiness): JsonLdObject {
  const phone = business.sample ? "" : business.phone.trim();
  return {
    "@context": CONTEXT,
    "@type": "Organization",
    "@id": organizationId(),
    name: organizationName(business),
    url: siteUrl("/"),
    logo: siteUrl("/icon.svg"),
    email: business.supportEmail,
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer support",
        email: business.supportEmail,
        ...(phone ? { telephone: phone } : {}),
        areaServed: "IN",
        availableLanguage: ["en"],
      },
    ],
  };
}

/** The site, with a sitelinks search box that opens the catalog search. */
export function websiteJsonLd(): JsonLdObject {
  return {
    "@context": CONTEXT,
    "@type": "WebSite",
    "@id": siteUrl("/#website"),
    name: SITE_NAME,
    url: siteUrl("/"),
    inLanguage: "en-IN",
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${siteUrl("/software")}?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
}

const UNIT_CODES: Partial<Record<NonNullable<StorePlan["interval"]>, string>> = { YEAR: "ANN", MONTH: "MON" };

function offerFor(plan: StorePlan, url: string): JsonLdObject {
  const price = paiseToDecimalString(plan.pricePaise);
  const unitCode = plan.interval ? UNIT_CODES[plan.interval] : undefined;
  return {
    "@type": "Offer",
    name: plan.name,
    url,
    price,
    priceCurrency: "INR",
    availability: "https://schema.org/InStock",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price,
      priceCurrency: "INR",
      valueAddedTaxIncluded: false,
      ...(unitCode ? { unitCode } : {}),
      ...(plan.perUnit ? { unitText: plan.perUnit } : {}),
    },
  };
}

/** One Offer per paid main plan (trials, device add-ons and maintenance are not offers), prices excluding GST. */
export function softwareApplicationJsonLd(product: StoreProduct): JsonLdObject {
  const url = siteUrl(productHref(product.id));
  const release = latestRelease(product);
  const offers = mainPlans(product)
    .filter((plan) => plan.pricePaise > 0)
    .map((plan) => offerFor(plan, url));
  return {
    "@context": CONTEXT,
    "@type": "SoftwareApplication",
    name: product.name,
    description: product.summary,
    url,
    applicationCategory: "BusinessApplication",
    operatingSystem: platformsLabel(product.platforms, ", "),
    ...(release ? { softwareVersion: release.version } : {}),
    publisher: { "@type": "Organization", "@id": organizationId(), name: SITE_NAME },
    ...(offers.length > 0 ? { offers } : {}),
  };
}

export type BreadcrumbItem = { name: string; path: string };

/** Home / Software / Product: positions start at 1, items are absolute URLs. */
export function breadcrumbJsonLd(items: readonly BreadcrumbItem[]): JsonLdObject {
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: item.name,
      item: siteUrl(item.path),
    })),
  };
}

export function faqPageJsonLd(faqs: readonly Pick<StoreFaq, "question" | "answer">[]): JsonLdObject {
  return {
    "@context": CONTEXT,
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({
      "@type": "Question",
      name: f.question,
      acceptedAnswer: { "@type": "Answer", text: f.answer },
    })),
  };
}

const BACKSLASH = String.fromCharCode(92);
// "<", ">" and "&" (so no "</script>" or HTML comment can appear) plus U+2028/U+2029.
const UNSAFE_CHARS = new RegExp(`[<>&${String.fromCharCode(0x2028, 0x2029)}]`, "g");

/** JSON for a <script type="application/ld+json"> element: "<" becomes \u003c (likewise ">", "&", U+2028/9). */
export function serializeJsonLd(data: JsonLdObject | readonly JsonLdObject[]): string {
  return JSON.stringify(data).replace(
    UNSAFE_CHARS,
    (c) => `${BACKSLASH}u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}
