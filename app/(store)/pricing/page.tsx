import Link from "next/link";
import { JsonLd } from "@/components/seo/json-ld";
import { STORE_PATHS } from "@/components/store/active-nav";
import { Container } from "@/components/store/container";
import { PriceToggle } from "@/components/store/price";
import { LicenseTypes } from "@/components/store/pricing/license-types";
import { MaintenanceGst } from "@/components/store/pricing/maintenance-gst";
import { PricingCta } from "@/components/store/pricing/pricing-cta";
import { PricingFaq } from "@/components/store/pricing/pricing-faq";
import { PricingMatrix } from "@/components/store/pricing/pricing-matrix";
import {
  MAINTENANCE_MONTHS,
  buildPricingMatrix,
  gstExample,
  monthsLabel,
  oneTimeUpdatePeriod,
  periodAdjective,
  periodSpan,
} from "@/components/store/pricing/pricing-model";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { PRICING_PAGE, licenseTypeCards, updatePeriodLabel } from "@/content/pricing";
import { taxSettingsForPricing } from "@/lib/config";
import { faqPageJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { getFaqs, getStoreProducts, getStoreSettings } from "@/lib/storefront/data";

export const metadata = buildMetadata({
  title: PRICING_PAGE.title,
  description: PRICING_PAGE.description,
  path: PRICING_PAGE.path,
});

/** Pricing & licensing (prototype Pricing.dc.html). Server-rendered; only the price toggle and the FAQ hydrate. */
export default async function PricingPage() {
  const [settings, products, faqs] = await Promise.all([getStoreSettings(), getStoreProducts(), getFaqs("pricing")]);
  const ratePct = settings.tax.gstRatePct;
  const sampleNotice = settings["content.sampleNotice"];
  const oneTime = oneTimeUpdatePeriod(products);
  const oneTimeUpdates = updatePeriodLabel(monthsLabel(oneTime.months), oneTime.varies);

  return (
    <>
      <Container as="section" className="pb-[clamp(40px,5vw,64px)] pt-7">
        <Breadcrumb>
          <BreadcrumbList className="gap-x-2 leading-[normal]">
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={STORE_PATHS.home}>{PRICING_PAGE.breadcrumbHome}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="text-ink-2" />
            <BreadcrumbItem>
              <BreadcrumbPage>{PRICING_PAGE.breadcrumb}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="mt-[22px] flex flex-wrap items-end justify-between gap-5">
          <div className="max-w-[720px]">
            <h1 className="m-0 text-balance text-[clamp(34px,4.4vw,52px)] font-extrabold leading-[1.05] tracking-[-0.04em]">
              {PRICING_PAGE.heading}
            </h1>
            <p className="mb-0 mt-4 text-[18px] leading-[1.6] text-ink-2">{PRICING_PAGE.lead}</p>
          </div>
          <PriceToggle ratePct={ratePct} />
        </div>
        <PricingMatrix
          className="mt-8"
          rows={buildPricingMatrix(products)}
          ratePct={ratePct}
          sampleNote={sampleNotice.enabled}
        />
      </Container>

      <LicenseTypes
        cards={licenseTypeCards({
          oneTimeUpdates,
          maintenanceCover: monthsLabel(MAINTENANCE_MONTHS),
          maintenanceSpan: periodSpan(MAINTENANCE_MONTHS),
        })}
      />

      <MaintenanceGst
        maintenance={{ oneTimeUpdates, maintenanceAdjective: periodAdjective(MAINTENANCE_MONTHS) }}
        ratePct={ratePct}
        example={gstExample(products, taxSettingsForPricing(settings))}
      />

      <PricingFaq faqs={faqs} />
      <PricingCta />

      {faqs.length > 0 ? <JsonLd data={faqPageJsonLd(faqs)} /> : null}
    </>
  );
}
