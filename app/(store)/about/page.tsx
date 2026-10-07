import Link from "next/link";
import { JsonLd } from "@/components/seo/json-ld";
import { STORE_PATHS } from "@/components/store/active-nav";
import { AboutHeroArt } from "@/components/store/about/about-hero-art";
import { aboutProductTiles, companyDetailRows } from "@/components/store/about/about-model";
import { AboutCompany, AboutPrinciples, AboutProducts } from "@/components/store/about/about-sections";
import { Container } from "@/components/store/container";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { ABOUT_HERO, ABOUT_PAGE } from "@/content/about";
import { organizationJsonLd } from "@/lib/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { getStoreProducts, getStoreSettings } from "@/lib/storefront/data";

export const metadata = buildMetadata({
  title: ABOUT_PAGE.title,
  description: ABOUT_PAGE.description,
  path: ABOUT_PAGE.path,
});

/** About us (prototype About.dc.html). Static server component; the header highlights Resources, as prototyped. */
export default async function AboutPage() {
  const [settings, products] = await Promise.all([getStoreSettings(), getStoreProducts()]);
  const { business } = settings;

  return (
    <>
      <Container as="section" className="pb-[clamp(48px,6vw,80px)] pt-7">
        <Breadcrumb>
          <BreadcrumbList className="gap-x-2 leading-[normal]">
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href={STORE_PATHS.home}>{ABOUT_PAGE.breadcrumbHome}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="text-ink-2" />
            <BreadcrumbItem>
              <BreadcrumbPage>{ABOUT_PAGE.breadcrumb}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(min(100%,440px),1fr))] items-center gap-[clamp(32px,5vw,72px)]">
          <div>
            {/* As prototyped: an inline 12.5px span on a 16px line (line-height normal), so the line box is ~22px. */}
            <p className="m-0 leading-[normal]">
              <span className="text-[12.5px] font-extrabold uppercase tracking-[0.14em] text-primary-link">
                {ABOUT_HERO.overline}
              </span>
            </p>
            <h1 className="mb-0 mt-3 text-balance text-[clamp(36px,4.6vw,56px)] font-extrabold leading-[1.04] tracking-[-0.04em]">
              {ABOUT_HERO.heading}
            </h1>
            <p className="mb-0 mt-[18px] text-[18px] leading-[1.65] text-ink-body">{ABOUT_HERO.lead}</p>
            {ABOUT_HERO.storyNote ? (
              <p className="mb-0 mt-2.5 text-[13.5px] font-semibold leading-[normal] text-ink-2">{ABOUT_HERO.storyNote}</p>
            ) : null}
          </div>
          <AboutHeroArt label={ABOUT_HERO.photoNote} />
        </div>
      </Container>

      <AboutPrinciples />
      <AboutProducts tiles={aboutProductTiles(products)} />
      <AboutCompany rows={companyDetailRows(business)} />

      <JsonLd data={organizationJsonLd(business)} />
    </>
  );
}
