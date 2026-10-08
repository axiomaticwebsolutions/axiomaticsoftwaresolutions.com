import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { toIconName } from "@/components/store/active-nav";
import { Price, TaxNote } from "@/components/store/price";
import { HOME_FEATURED, priceNote } from "@/content/home";
import { productHref, startingPlan, unitLabel } from "@/lib/storefront/derive";
import type { StoreProduct } from "@/lib/storefront/types";
import { cn } from "@/lib/utils";
import { HOME_TONE_CLASSES } from "./styles";

/** The hero shows the first four published products (by rank); the full list follows in "Our software". */
export const HERO_PRODUCT_LIMIT = 4;

export type HeroProductTilesProps = {
  products: readonly StoreProduct[];
  /** GST rate for the incl. prices (settings tax.gstRatePct). */
  ratePct: number;
};

/**
 * Hero design C (owner's choice, 2026-10-08): the products as pastel tiles in a 2 x 2 grid next to the hero text, each
 * with its icon, name, starting price and a "View details" cue; the whole tile links to the product page. Prices
 * come from the live catalogue (startingPlan), so Admin price edits show here too. Server.
 */
export function HeroProductTiles({ products, ratePct }: HeroProductTilesProps) {
  const shown = products.slice(0, HERO_PRODUCT_LIMIT);
  return (
    <ul aria-label="Our software" className="m-0 grid list-none grid-cols-2 gap-[clamp(10px,1.4vw,16px)] p-0">
      {shown.map((product) => {
        const tone = HOME_TONE_CLASSES[product.tone];
        const plan = startingPlan(product);
        const note = plan ? priceNote(unitLabel(plan)) : null;
        return (
          <li key={product.id} className="flex">
            <Link
              href={productHref(product.id)}
              className={cn(
                "group flex flex-1 flex-col rounded-22 p-[clamp(14px,1.8vw,22px)] text-ink no-underline",
                "transition-[box-shadow,translate] duration-200 hover:shadow-card-hover motion-safe:hover:-translate-y-0.5",
                tone.bg,
              )}
            >
              <span
                aria-hidden="true"
                className={cn("grid size-[clamp(38px,3.4vw,46px)] place-items-center rounded-14 bg-white shadow-tile", tone.fg)}
              >
                <Icon name={toIconName(product.icon)} size={24} />
              </span>
              <span className="mt-[clamp(12px,1.6vw,20px)] text-[clamp(15px,1.35vw,18px)] leading-[1.25] font-extrabold tracking-[-0.015em] text-pretty">
                {product.name}
              </span>
              {plan && note ? (
                <span className={cn("mt-1.5 flex flex-wrap items-baseline gap-x-1 text-[13px] font-semibold", tone.fg)}>
                  <span>{HOME_FEATURED.from}</span>
                  <Price paise={plan.pricePaise} ratePct={ratePct} className="font-extrabold" />
                  <TaxNote excl={note.excl} incl={note.incl} />
                </span>
              ) : null}
              <span className="mt-auto flex items-center gap-1 pt-[clamp(12px,1.6vw,18px)] text-[13.5px] font-bold text-ink-2 group-hover:text-ink">
                {HOME_FEATURED.viewDetails}
                <Icon name="arrow_forward" size={17} className="transition-transform motion-safe:group-hover:translate-x-0.5" />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
