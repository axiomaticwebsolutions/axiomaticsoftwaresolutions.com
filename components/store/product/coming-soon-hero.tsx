import Link from "next/link";
import { Fragment } from "react";
import { Icon } from "@/components/icons/icon";
import { toIconName } from "@/components/store/active-nav";
import { Container } from "@/components/store/container";
import { Button } from "@/components/ui/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import type { BreadcrumbItem as Crumb } from "@/lib/seo/json-ld";
import { platformsLabel } from "@/lib/storefront/derive";
import type { StoreProduct } from "@/lib/storefront/types";
import { cn } from "@/lib/utils";
import { COMING_SOON_COPY } from "./copy";
import { PRODUCT_TONES } from "./tones";
import { WaitlistForm } from "./waitlist-form";

/** /software?availability=available: the products on sale now. */
const AVAILABLE_NOW_HREF = "/software?availability=available";

const CHIP = "flex items-center gap-1.5 rounded-10 px-3 py-[7px]";

/**
 * Hero of a COMING_SOON product page (decisions.md 2026-10-09): breadcrumb, icon + category, the "Coming soon" badge,
 * name, tagline, summary and platforms, with the "Notify me when it launches" form on the right. No price, plans,
 * trial, demo or download: the product is not on sale yet.
 */
export function ComingSoonHero({ product, crumbs }: { product: StoreProduct; crumbs: readonly Crumb[] }) {
  const t = PRODUCT_TONES[product.tone];
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

        {/* Two columns from lg, the same breakpoint that hides the "Notify me" jump button below. */}
        <div className="mt-7 grid grid-cols-[minmax(0,1fr)] items-start gap-[clamp(32px,5vw,64px)] lg:grid-cols-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span
                aria-hidden="true"
                className={cn("grid size-[52px] place-items-center rounded-16 bg-surface shadow-tile", t.fg)}
              >
                <Icon name={toIconName(product.icon)} size={28} />
              </span>
              <span className={cn("rounded-pill border px-[11px] py-[5px] text-[13px] font-bold", t.bg, t.fg, t.line)}>
                {product.category.name}
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-pill border border-lavender-line bg-surface px-[11px] py-[5px] text-[13px] font-bold text-lavender-fg">
                <Icon name="schedule" size={16} />
                {COMING_SOON_COPY.badge}
              </span>
            </div>
            <h1 id="product-title" className="m-0 mt-5 text-balance text-h1-product">
              {product.name}
            </h1>
            <p className="m-0 mt-[18px] max-w-[560px] text-[19px] font-bold leading-[1.5] text-ink">{product.tagline}</p>
            <p className="m-0 mt-3 max-w-[560px] text-[17px] leading-[1.6] text-ink-body">{product.summary}</p>

            {product.platforms.length > 0 ? (
              <ul className="m-0 mt-5 flex list-none flex-wrap gap-2 p-0 text-[13.5px] font-bold">
                <li className={cn(CHIP, "border border-line bg-surface")}>
                  <Icon name="computer" size={18} className="my-0.5" />
                  {platformsLabel(product.platforms)}
                </li>
              </ul>
            ) : null}

            <p className="m-0 mt-6 max-w-[560px] text-[15px] font-semibold leading-[1.6] text-ink-2">{COMING_SOON_COPY.heroNote}</p>
            <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
              {/* One column (below lg): the form is further down, so jump to it. */}
              <Button asChild size="lg" className="rounded-14 px-[22px] py-3.5 text-[16px] leading-[normal] lg:hidden">
                <a href="#notify">{COMING_SOON_COPY.notifyCta}</a>
              </Button>
              <Link
                href={AVAILABLE_NOW_HREF}
                className="inline-block rounded-6 font-bold text-primary-link underline hover:text-primary-link-hover"
              >
                {COMING_SOON_COPY.browseAvailable} <span aria-hidden="true">→</span>
              </Link>
            </div>
          </div>

          <div id="notify" className="min-w-0 scroll-mt-2.5">
            <WaitlistForm productId={product.id} productName={product.name} shortName={product.shortName} />
          </div>
        </div>
      </Container>
    </section>
  );
}
