import { afterAll, beforeAll, describe, expect, it } from "vitest";
import robots from "@/app/robots";
import {
  breadcrumbJsonLd,
  faqPageJsonLd,
  organizationJsonLd,
  organizationName,
  serializeJsonLd,
  softwareApplicationJsonLd,
  websiteJsonLd,
  type JsonLdObject,
} from "@/lib/seo/json-ld";
import { OG_IMAGE_ALT, ROBOTS_DISALLOW, buildMetadata, siteOrigin, siteUrl } from "@/lib/seo/metadata";
import { fixtureFaqs, fixtureProduct, fixtureSettings } from "@/lib/storefront/fixtures";
import type { StoreProduct } from "@/lib/storefront/types";

const ORIGIN = "https://axiomatic.example";
let savedAppUrl: string | undefined;

beforeAll(() => {
  savedAppUrl = process.env.APP_URL;
  process.env.APP_URL = `${ORIGIN}/`;
});

afterAll(() => {
  if (savedAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = savedAppUrl;
});

function product(id: string): StoreProduct {
  const found = fixtureProduct(id);
  if (!found) throw new Error(`no product ${id}`);
  return found;
}

describe("site URLs", () => {
  it("builds absolute URLs from APP_URL", () => {
    expect(siteOrigin()).toBe(ORIGIN);
    expect(siteUrl()).toBe(`${ORIGIN}/`);
    expect(siteUrl("/software/medical-billing")).toBe(`${ORIGIN}/software/medical-billing`);
    expect(siteUrl("pricing")).toBe(`${ORIGIN}/pricing`);
    expect(siteUrl("https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
  });
});

describe("buildMetadata", () => {
  it("adds the canonical URL, OpenGraph and a large Twitter card", () => {
    const meta = buildMetadata({ title: "Pricing & licensing", description: "Plans in INR.", path: "/pricing" });
    expect(meta.title).toBe("Pricing & licensing");
    expect(meta.description).toBe("Plans in INR.");
    expect(meta.alternates?.canonical).toBe(`${ORIGIN}/pricing`);
    expect(meta.openGraph).toMatchObject({
      type: "website",
      siteName: "Axiomatic Software Solutions",
      locale: "en_IN",
      url: `${ORIGIN}/pricing`,
      title: "Pricing & licensing",
      description: "Plans in INR.",
      images: [{ url: `${ORIGIN}/opengraph-image`, width: 1200, height: 630, alt: OG_IMAGE_ALT }],
    });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image", title: "Pricing & licensing" });
    expect(meta.robots).toBeUndefined();
  });

  it("supports noindex, absolute titles and segment images", () => {
    const meta = buildMetadata({
      title: "Compare software",
      description: "Side by side.",
      path: "/compare",
      noindex: true,
      absoluteTitle: true,
      images: "segment",
    });
    expect(meta.title).toEqual({ absolute: "Compare software" });
    expect(meta.robots).toEqual({ index: false, follow: true });
    expect(meta.openGraph && "images" in meta.openGraph).toBe(false);
    expect(meta.twitter && "images" in meta.twitter).toBe(false);
    const custom = buildMetadata({ title: "X", description: "Y", path: "/x", images: [{ url: "/x.png", alt: "X" }] });
    expect(custom.openGraph?.images).toEqual([{ url: `${ORIGIN}/x.png`, alt: "X" }]);
  });
});

describe("robots.txt", () => {
  it("keeps private areas out and points at the sitemap", () => {
    expect(robots()).toEqual({
      rules: [
        {
          userAgent: "*",
          allow: "/",
          disallow: ["/account", "/admin", "/api", "/dev", "/cart", "/checkout", "/orders", "/compare", "/invite", "/staff-invite"],
        },
      ],
      sitemap: `${ORIGIN}/sitemap.xml`,
    });
    expect(ROBOTS_DISALLOW).toContain("/compare");
  });
});

describe("JSON-LD", () => {
  it("publishes the brand name and no placeholder telephone while the business details are samples", () => {
    const business = fixtureSettings().business;
    expect(business.sample).toBe(true);
    const org = organizationJsonLd(business);
    expect(org).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": `${ORIGIN}/#organization`,
      name: "Axiomatic Software Solutions",
      url: `${ORIGIN}/`,
      logo: `${ORIGIN}/icon.svg`,
      email: "support@axiomatic.example",
      contactPoint: [
        {
          "@type": "ContactPoint",
          contactType: "customer support",
          email: "support@axiomatic.example",
          areaServed: "IN",
          availableLanguage: ["en"],
        },
      ],
    });
    expect(JSON.stringify(org)).not.toContain("placeholder");
  });

  it("publishes the legal name and telephone once the business details are real", () => {
    const real = {
      ...fixtureSettings().business,
      sample: false,
      legalName: "Axiomatic Software Solutions Pvt. Ltd.",
      phone: " +91 98765 43210 ",
    };
    expect(organizationName(real)).toBe("Axiomatic Software Solutions Pvt. Ltd.");
    expect(organizationJsonLd(real)).toMatchObject({
      name: "Axiomatic Software Solutions Pvt. Ltd.",
      contactPoint: [{ telephone: "+91 98765 43210" }],
    });
    // An empty legal name or phone falls back to the brand name and leaves the telephone out.
    const blank = organizationJsonLd({ ...real, legalName: " ", phone: "" });
    expect(blank.name).toBe("Axiomatic Software Solutions");
    expect(JSON.stringify(blank)).not.toContain("telephone");
  });


  it("adds a catalog search action to the website", () => {
    expect(websiteJsonLd()).toMatchObject({
      "@type": "WebSite",
      url: `${ORIGIN}/`,
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${ORIGIN}/software?q={search_term_string}` },
        "query-input": "required name=search_term_string",
      },
    });
  });

  it("emits one INR offer per paid main plan, excluding GST", () => {
    const med = softwareApplicationJsonLd(product("medical-billing"));
    expect(med).toMatchObject({
      "@type": "SoftwareApplication",
      name: "Medical Store Billing Software",
      applicationCategory: "BusinessApplication",
      operatingSystem: "Windows",
      softwareVersion: "4.2.1",
      url: `${ORIGIN}/software/medical-billing`,
    });
    expect(med.offers).toEqual([
      {
        "@type": "Offer",
        name: "Annual license",
        url: `${ORIGIN}/software/medical-billing`,
        price: "4999.00",
        priceCurrency: "INR",
        availability: "https://schema.org/InStock",
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: "4999.00",
          priceCurrency: "INR",
          valueAddedTaxIncluded: false,
          unitCode: "ANN",
        },
      },
      {
        "@type": "Offer",
        name: "One-time license",
        url: `${ORIGIN}/software/medical-billing`,
        price: "12999.00",
        priceCurrency: "INR",
        availability: "https://schema.org/InStock",
        priceSpecification: { "@type": "UnitPriceSpecification", price: "12999.00", priceCurrency: "INR", valueAddedTaxIncluded: false },
      },
    ]);
    const offers = (id: string) => softwareApplicationJsonLd(product(id)).offers as JsonLdObject[];
    expect(offers("restaurant-billing").map((o) => o.price)).toEqual(["699.00", "6999.00"]);
    expect(offers("restaurant-billing")[0]?.priceSpecification).toMatchObject({ unitCode: "MON", unitText: "terminal" });
    expect(offers("general-store-gst").map((o) => o.name)).toEqual(["Annual license", "One-time license", "Multi-user license"]);
    expect(offers("cheque-printing").map((o) => o.price)).toEqual(["2999.00", "6999.00"]);
    expect(softwareApplicationJsonLd(product("restaurant-billing")).operatingSystem).toBe("Windows, Android");
    const noPaid = softwareApplicationJsonLd({ ...product("medical-billing"), plans: [], releases: [] });
    expect(noPaid.offers).toBeUndefined();
    expect(noPaid.softwareVersion).toBeUndefined();
  });

  it("builds breadcrumbs and FAQ pages", () => {
    expect(
      breadcrumbJsonLd([
        { name: "Home", path: "/" },
        { name: "Software", path: "/software" },
        { name: "Medical Store Billing", path: "/software/medical-billing" },
      ]),
    ).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home", item: `${ORIGIN}/` },
        { "@type": "ListItem", position: 2, name: "Software", item: `${ORIGIN}/software` },
        { "@type": "ListItem", position: 3, name: "Medical Store Billing", item: `${ORIGIN}/software/medical-billing` },
      ],
    });
    const faq = faqPageJsonLd(fixtureFaqs("pricing"));
    const entities = faq.mainEntity as JsonLdObject[];
    expect(entities).toHaveLength(6);
    expect(entities[0]).toEqual({
      "@type": "Question",
      name: "Can I start on a trial and keep my data?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. When you buy, activate the same installation with your new key. Your bills, items and settings stay as they are.",
      },
    });
  });

  it("serializes to valid JSON that cannot break out of the script element", () => {
    const hostile: JsonLdObject = { "@type": "Thing", name: "</script><script>alert(1)</script> & <!-- x -->", note: "a\u2028b" };
    const out = serializeJsonLd([hostile, faqPageJsonLd([{ question: "<b>?</b>", answer: "1 < 2 & 3 > 2" }])]);
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(out).toContain(String.raw`\u003c/script\u003e`);
    expect(out).toContain(String.raw`\u0026`);
    expect(out).toContain(String.raw`\u2028`);
    expect(JSON.parse(out)).toEqual([hostile, faqPageJsonLd([{ question: "<b>?</b>", answer: "1 < 2 & 3 > 2" }])]);
  });
});
