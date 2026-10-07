import { JsonLd } from "@/components/seo/json-ld";
import { SupportFaqs, SupportSearchForm, SupportSearchProvider } from "@/components/store/support/support-search";
import { SupportChannels, SupportPopularTopics, SupportTasks } from "@/components/store/support/support-sections";
import { SUPPORT_HERO, SUPPORT_META } from "@/content/support";
import { faqPageJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { getFaqs, getStoreSettings } from "@/lib/storefront/data";

export const metadata = buildMetadata({
  title: SUPPORT_META.title,
  description: SUPPORT_META.description,
  path: SUPPORT_META.path,
});

/**
 * /support (Support.dc.html): sage hero with the FAQ search and popular topics, "Do it yourself" task cards, the
 * support channels (hours and contacts from settings), and the support FAQs (Faq page "support") with FAQPage
 * JSON-LD. The search filters the FAQs on the client; everything else is static.
 */
export default async function SupportPage() {
  const [settings, faqs] = await Promise.all([getStoreSettings(), getFaqs("support")]);

  return (
    <SupportSearchProvider>
      {faqs.length > 0 ? <JsonLd data={faqPageJsonLd(faqs)} /> : null}
      <section aria-labelledby="support-title" className="border-b border-sage-line bg-sage-bg leading-[normal]">
        <div className="mx-auto max-w-[880px] px-4 py-[clamp(40px,6vw,72px)] text-center sm:px-6">
          <h1 id="support-title" className="m-0 text-[clamp(32px,4.2vw,48px)] font-extrabold tracking-[-0.04em]">
            {SUPPORT_HERO.title}
          </h1>
          <SupportSearchForm />
          <SupportPopularTopics />
        </div>
      </section>
      <SupportTasks />
      <SupportChannels business={settings.business} />
      <section
        aria-labelledby="support-faq-title"
        className="mx-auto max-w-[880px] px-4 py-[clamp(40px,5vw,64px)] leading-[normal] sm:px-6"
      >
        <SupportFaqs faqs={faqs} />
      </section>
    </SupportSearchProvider>
  );
}
