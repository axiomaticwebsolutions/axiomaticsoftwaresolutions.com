import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { toIconName } from "@/components/store/active-nav";
import { Container } from "@/components/store/container";
import { Price, PriceToggle, TaxNote } from "@/components/store/price";
import { SectionHeading } from "@/components/store/section-heading";
import { Button } from "@/components/ui/button";
import { VisuallyHidden } from "@/components/ui/visually-hidden";
import { HOME_FEATURED, priceNote, productSecondaryCta } from "@/content/home";
import { platformsLabel, productHref, startingPlan, unitLabel } from "@/lib/storefront/derive";
import type { StoreProduct } from "@/lib/storefront/types";
import { cn } from "@/lib/utils";
import { HOME_OVERLINE_LINE, HOME_TONE_CLASSES, WRAP } from "./styles";

export type FeaturedProductsProps = {
  /** Published products by rank (all of them: docs/decisions.md > Phase 2). */
  products: readonly StoreProduct[];
  /** GST rate for the incl. prices and the toggle label (settings tax.gstRatePct). */
  ratePct: number;
};

/** "Our software": product cards with the Excl./Incl. GST toggle (Home.dc.html section 2). Server. */
export function FeaturedProducts({ products, ratePct }: FeaturedProductsProps) {
  if (products.length === 0) return null;
  return (
    <Container as="section" aria-labelledby="feat-h" className="py-[clamp(56px,7vw,96px)]">
      <SectionHeading
        id="feat-h"
        size="display-section"
        overline={HOME_FEATURED.overline}
        title={HOME_FEATURED.title}
        overlineClassName={HOME_OVERLINE_LINE}
        titleClassName={WRAP}
        actions={<PriceToggle ratePct={ratePct} />}
        className="gap-4"
      />
      <ul
        className="m-0 mt-9 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,270px),1fr))] gap-5 p-0"
      >
        {products.map((product) => (
          <li key={product.id} className="flex">
            <ProductCard product={product} ratePct={ratePct} />
          </li>
        ))}
      </ul>
    </Container>
  );
}

function ProductCard({ product, ratePct }: { product: StoreProduct; ratePct: number }) {
  const tone = HOME_TONE_CLASSES[product.tone];
  const plan = startingPlan(product);
  const note = plan ? priceNote(unitLabel(plan)) : null;
  const secondary = productSecondaryCta(product);
  const href = productHref(product.id);

  return (
    <article
      className={cn(
        "flex flex-1 flex-col overflow-hidden rounded-22 border border-line bg-white",
        // Tailwind 4's translate utilities write the `translate` property, so that is what transitions (not transform).
        "transition-[box-shadow,translate] duration-200 hover:shadow-card-hover motion-safe:hover:-translate-y-0.5",
      )}
    >
      {/* Tinted header: product icon and a sketched screen (decorative). */}
      <div aria-hidden="true" className={cn("relative h-[150px] overflow-hidden px-[22px] pt-[22px]", tone.bg)}>
        <span className={cn("grid size-[46px] place-items-center rounded-14 bg-white shadow-tile", tone.fg)}>
          <Icon name={toIconName(product.icon)} size={25} />
        </span>
        <div
          className={cn(
            "absolute top-[30px] right-[-30px] bottom-[-12px] left-[84px] grid content-start gap-[7px] rounded-t-12 bg-white px-3.5 py-3",
            "shadow-[0_10px_30px_--alpha(theme(colors.ink)/8%)]",
          )}
        >
          <span className={cn("h-[7px] w-[46%] rounded-[4px] opacity-55", tone.fill)} />
          <span className="h-1.5 w-[82%] rounded-[4px] bg-line-subtle" />
          <span className="h-1.5 w-[70%] rounded-[4px] bg-line-subtle" />
          <span className="h-1.5 w-[76%] rounded-[4px] bg-line-subtle" />
        </div>
      </div>

      <div className="flex flex-1 flex-col p-[22px]">
        <span className={cn("self-start rounded-pill px-2.5 py-1 text-[12px] font-bold", tone.bg, tone.fg)}>
          {product.category.name}
        </span>
        <h3 className={cn("mt-3 mb-0 text-[19px] leading-[1.25] font-extrabold tracking-[-0.02em]", WRAP)}>{product.name}</h3>
        <p className="mt-2 mb-0 flex-1 text-[14.5px] leading-[1.55] text-ink-2">{product.tagline}</p>
        {plan && note ? (
          <p className="mt-[18px] mb-0 flex flex-wrap items-baseline gap-1.5">
            <span className="text-[13px] font-semibold text-ink-2">{HOME_FEATURED.from}</span>
            <Price paise={plan.pricePaise} ratePct={ratePct} className="text-[22px] font-extrabold tracking-[-0.02em]" />
            <TaxNote excl={note.excl} incl={note.incl} className="text-[13px] font-semibold text-ink-2" />
          </p>
        ) : null}
        {product.platforms.length > 0 ? (
          <p className={cn("mb-0 text-[13px] font-semibold text-ink-2", plan ? "mt-1" : "mt-[18px]")}>
            {platformsLabel(product.platforms)}
          </p>
        ) : null}
        <div className="mt-[18px] flex gap-2">
          <Button asChild className={CARD_BUTTON}>
            <Link href={href}>
              {HOME_FEATURED.viewDetails}
              <VisuallyHidden>: {product.name}</VisuallyHidden>
            </Link>
          </Button>
          {secondary ? (
            <Button asChild variant="secondary" className={CARD_BUTTON}>
              <Link href={secondary.href}>
                {secondary.label}
                <VisuallyHidden>: {product.name}</VisuallyHidden>
              </Link>
            </Button>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** Card buttons share the row equally and may wrap ("Request demo" wraps on narrow cards, as in the prototype). */
const CARD_BUTTON = "flex-1 whitespace-normal px-3.5 text-center text-[14.5px] leading-[normal]";
