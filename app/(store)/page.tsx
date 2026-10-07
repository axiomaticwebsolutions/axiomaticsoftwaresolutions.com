import { JsonLd } from "@/components/seo/json-ld";
import { BusinessCategories } from "@/components/store/home/business-categories";
import { FeaturedProducts } from "@/components/store/home/featured-products";
import { FinalCta } from "@/components/store/home/final-cta";
import { HomeHero } from "@/components/store/home/hero";
import { HomeFaq } from "@/components/store/home/home-faq";
import { HowItWorks } from "@/components/store/home/how-it-works";
import { SupportAndMaintenance } from "@/components/store/home/support-maintenance";
import { WhyAxiomatic } from "@/components/store/home/why-axiomatic";
import { announcementHref, announcementText, HOME_META, oneTimeUpdatesMonths } from "@/content/home";
import { organizationJsonLd, websiteJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { getFaqs, getLatestRelease, getStoreCategories, getStoreProducts, getStoreSettings } from "@/lib/storefront/data";

export const metadata = buildMetadata({
  title: HOME_META.title,
  description: HOME_META.description,
  path: "/",
  absoluteTitle: true,
});

/** Home (Home.dc.html). Every block reads cached storefront data; static copy lives in content/home.ts. */
export default async function HomePage() {
  const [settings, products, categories, faqs, latest] = await Promise.all([
    getStoreSettings(),
    getStoreProducts(),
    getStoreCategories(),
    getFaqs("home"),
    getLatestRelease(),
  ]);
  const ratePct = settings.tax.gstRatePct;

  return (
    // The prototype leaves line-height at "normal" unless a rule sets it; the store body default is 1.6.
    <div className="leading-[normal]">
      <JsonLd data={[organizationJsonLd(settings.business), websiteJsonLd()]} />
      <HomeHero announcement={latest ? { text: announcementText(latest), href: announcementHref(latest) } : null} />
      <FeaturedProducts products={products} ratePct={ratePct} />
      <BusinessCategories categories={categories.filter((category) => category.productCount > 0)} />
      <WhyAxiomatic />
      <HowItWorks />
      <SupportAndMaintenance
        hours={settings.business.hours}
        sample={settings.business.sample}
        updatesMonths={oneTimeUpdatesMonths(products)}
      />
      <HomeFaq faqs={faqs} />
      <FinalCta />
    </div>
  );
}
