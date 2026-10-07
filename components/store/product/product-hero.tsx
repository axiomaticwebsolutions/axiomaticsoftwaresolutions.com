import Link from "next/link";
import { Fragment } from "react";
import type { ProductScreenshot } from "@/content/screenshots";
import { Icon } from "@/components/icons/icon";
import { toIconName } from "@/components/store/active-nav";
import { Container } from "@/components/store/container";
import { Price, TaxNote } from "@/components/store/price";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import type { BreadcrumbItem as Crumb } from "@/lib/seo/json-ld";
import {
  demoHref,
  latestRelease,
  platformsLabel,
  startingPlan,
  trialHref,
  trialPlan,
  unitLabel,
} from "@/lib/storefront/derive";
import type { StoreProduct } from "@/lib/storefront/types";
import { cn } from "@/lib/utils";
import { PRODUCT_COPY } from "./copy";
import { trialChipLabel } from "./model";
import { ScreenshotTabs } from "./screenshot-tabs";
import { PRODUCT_TONES } from "./tones";

export type ProductHeroProps = {
  product: StoreProduct;
  crumbs: readonly Crumb[];
  shots: readonly ProductScreenshot[];
  ratePct: number;
};

const CHIP = "flex items-center gap-1.5 rounded-10 px-3 py-[7px]";
const HERO_CTA = "rounded-14 px-[22px] py-3.5 text-[16px] leading-[normal]";

/** Tinted hero: breadcrumb, icon + category, name, summary, chips, "From" price, CTAs and the screenshot panel. */
export function ProductHero({ product, crumbs, shots, ratePct }: ProductHeroProps) {
  const t = PRODUCT_TONES[product.tone];
  const release = latestRelease(product);
  const trial = trialPlan(product);
  const from = startingPlan(product);

  return (
    <section aria-labelledby="product-title" className={cn("border-b", t.soft, t.line)}>
      <Container className="pb-[clamp(40px,6vw,72px)] pt-6">
        <Breadcrumb>
          <BreadcrumbList className="gap-2">
            {crumbs.map((crumb, i) => {
              const last = i === crumbs.length - 1;
              return (
                <Fragment key={crumb.path}>
                  <BreadcrumbItem>
                    {last ? (
                      <BreadcrumbPage className="whitespace-normal">{crumb.name}</BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <Link href={crumb.path}>{crumb.name}</Link>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                  {last ? null : <BreadcrumbSeparator className="text-ink-2" />}
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>

        <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(min(100%,440px),1fr))] items-center gap-[clamp(32px,5vw,64px)]">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className={cn("grid size-[52px] place-items-center rounded-16 bg-surface shadow-tile", t.fg)}
              >
                <Icon name={toIconName(product.icon)} size={28} />
              </span>
              <span className={cn("rounded-pill border px-[11px] py-[5px] text-[13px] font-bold", t.bg, t.fg, t.line)}>
                {product.category.name}
              </span>
            </div>
            <h1 id="product-title" className="m-0 mt-5 text-balance text-h1-product">
              {product.name}
            </h1>
            <p className="m-0 mt-[18px] max-w-[560px] text-[18px] leading-[1.6] text-ink-body">{product.summary}</p>

            <ul className="m-0 mt-5 flex list-none flex-wrap gap-2 p-0 text-[13.5px] font-bold">
              {product.platforms.length > 0 ? (
                <li className={cn(CHIP, "border border-line bg-surface")}>
                  <Icon name="computer" size={18} className="my-0.5" />
                  {platformsLabel(product.platforms)}
                </li>
              ) : null}
              {release ? (
                <li className={cn(CHIP, "border border-line bg-surface")}>
                  <Icon name="new_releases" size={18} className="my-0.5" />
                  {PRODUCT_COPY.versionChip(release.version)}
                </li>
              ) : null}
              {trial ? (
                <li className={cn(CHIP, "bg-sage-bg text-sage-fg")}>
                  <Icon name="timer" size={18} className="my-0.5" />
                  {trialChipLabel(trial)}
                </li>
              ) : null}
            </ul>

            {from ? (
              <p className="m-0 mt-7 flex flex-wrap items-baseline gap-2">
                <span className="text-[14px] font-semibold text-ink-2">{PRODUCT_COPY.from}</span>
                <Price paise={from.pricePaise} ratePct={ratePct} className="text-[32px] font-extrabold tracking-[-0.03em]" />
                <span className="text-[14px] font-semibold text-ink-2">
                  {unitLabel(from)} <TaxNote />
                </span>
              </p>
            ) : null}

            <div className="mt-5 flex flex-wrap gap-2.5">
              <Button asChild size="lg" className={HERO_CTA}>
                <a href="#plans">{PRODUCT_COPY.choosePlan}</a>
              </Button>
              {trial ? (
                <Button asChild size="lg" variant="secondary" className={HERO_CTA}>
                  <Link href={trialHref(product.id)}>{PRODUCT_COPY.startTrial}</Link>
                </Button>
              ) : null}
              {product.demoEnabled ? (
                <Button
                  asChild
                  size="lg"
                  variant="ghost"
                  className={cn(HERO_CTA, "hover:bg-surface/70 hover:text-ink")}
                >
                  <Link href={demoHref(product.id)}>{PRODUCT_COPY.requestDemo}</Link>
                </Button>
              ) : null}
            </div>
          </div>

          <div className="min-w-0">
            <ScreenshotTabs shortName={product.shortName} tone={product.tone} shots={shots} />
          </div>
        </div>
      </Container>
    </section>
  );
}
