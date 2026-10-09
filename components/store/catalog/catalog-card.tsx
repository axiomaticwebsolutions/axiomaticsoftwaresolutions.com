import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { TONE_TILE_CLASSES, toIconName } from "@/components/store/active-nav";
import { Price, TaxNote } from "@/components/store/price";
import { Checkbox } from "@/components/ui/checkbox";
import type { Tone } from "@/lib/design/tokens";
import type { CatalogItem } from "@/lib/storefront/catalog-filter";
import { LICENSE_TYPE_LABELS, platformsLabel, productHref } from "@/lib/storefront/derive";
import { cn } from "@/lib/utils";

/** Preview panel background per tone. */
const TONE_BG: Readonly<Record<Tone, string>> = {
  lavender: "bg-lavender-bg",
  sage: "bg-sage-bg",
  blue: "bg-blue-bg",
  peach: "bg-peach-bg",
  pink: "bg-pink-bg",
};

/** Icon colour on the white preview tile. */
const TONE_TEXT: Readonly<Record<Tone, string>> = {
  lavender: "text-lavender-fg",
  sage: "text-sage-fg",
  blue: "text-blue-fg",
  peach: "text-peach-fg",
  pink: "text-pink-fg",
};

/** The accent bar of the decorative preview (tone fg at 50%). */
const TONE_FILL: Readonly<Record<Tone, string>> = {
  lavender: "bg-lavender-fg",
  sage: "bg-sage-fg",
  blue: "bg-blue-fg",
  peach: "bg-peach-fg",
  pink: "bg-pink-fg",
};

export type CatalogCardProps = {
  item: CatalogItem;
  /** In the compare selection. */
  compared: boolean;
  onToggleCompare: (id: string) => void;
  /** GST rate for the incl. price variant (settings tax.gstRatePct). */
  ratePct: number;
};

/** The card's "Coming soon" pill (text and icon, not colour alone). */
const COMING_SOON_BADGE_CLASS =
  "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-pill border border-lavender-line bg-lavender-soft px-2.5 py-1 text-[12px] font-bold text-lavender-fg";

/**
 * Catalog result card (Software.dc.html): tinted preview, category badge, "Free trial", license-type chips, "From" price
 * with the tax note, OS line, "View details" and the Compare checkbox. A coming-soon product shows a "Coming soon"
 * badge instead, with no price and no Compare (it is not sold). Rendered inside the client CatalogView (the Compare
 * checkbox needs handlers), so import it from client code only.
 */
export function CatalogCard({ item, compared, onToggleCompare, ratePct }: CatalogCardProps) {
  const href = productHref(item.id);
  return (
    <article
      className={cn(
        "flex w-full flex-col overflow-hidden rounded-22 border bg-surface transition-shadow duration-200",
        "animate-[enter-up_350ms_ease_both] hover:shadow-card-hover motion-reduce:animate-none",
        compared ? "border-primary-accent" : "border-line",
      )}
    >
      {/* Decorative preview; the title link below is the accessible link to the product. */}
      <Link
        href={href}
        tabIndex={-1}
        aria-hidden="true"
        className={cn("relative block h-[140px] overflow-hidden p-5", TONE_BG[item.tone])}
      >
        <span className={cn("grid size-11 place-items-center rounded-14 bg-surface", TONE_TEXT[item.tone])}>
          <Icon name={toIconName(item.icon)} size={24} />
        </span>
        <span className="absolute -bottom-2.5 -right-6 left-20 top-7 grid content-start gap-[7px] rounded-t-12 bg-surface px-3.5 py-3 shadow-[0_10px_30px_--alpha(theme(colors.ink)/8%)]">
          <span className={cn("h-[7px] w-[46%] rounded-[4px] opacity-50", TONE_FILL[item.tone])} />
          <span className="h-1.5 w-[82%] rounded-[4px] bg-line-subtle" />
          <span className="h-1.5 w-[70%] rounded-[4px] bg-line-subtle" />
          <span className="h-1.5 w-[76%] rounded-[4px] bg-line-subtle" />
        </span>
      </Link>

      <div className="flex flex-1 flex-col px-[22px] pb-[22px] pt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={cn("rounded-pill px-2.5 py-1 text-[12px] font-bold", TONE_TILE_CLASSES[item.tone])}>
            {item.categoryName}
          </span>
          {item.comingSoon ? (
            <span className={COMING_SOON_BADGE_CLASS}>
              <Icon name="schedule" size={14} />
              Coming soon
            </span>
          ) : item.hasTrial ? (
            <span className="text-[12px] font-bold text-sage-fg">Free trial</span>
          ) : null}
        </div>
        <h2 className="mt-3 text-[19px] font-extrabold leading-[1.25] tracking-[-0.02em]">
          <Link href={href} className="rounded-6 text-ink no-underline transition-colors hover:text-primary-link">
            {item.name}
          </Link>
        </h2>
        <p className="mt-2 flex-1 text-[14.5px] leading-[1.55] text-ink-2">{item.tagline}</p>

        {item.licenseTypes.length > 0 ? (
          <ul aria-label="License types" className="mt-3.5 flex list-none flex-wrap gap-1.5 p-0">
            {item.licenseTypes.map((key) => (
              <li key={key} className="rounded-8 bg-slate-bg px-[9px] py-[3px] text-[12px] font-bold text-ink-2">
                {LICENSE_TYPE_LABELS[key]}
              </li>
            ))}
          </ul>
        ) : null}

        {item.startingPricePaise !== null && item.startingUnit !== null ? (
          <p className="mt-4 flex flex-wrap items-baseline gap-1.5">
            <span className="text-[13px] font-semibold text-ink-2">From</span>
            <Price
              paise={item.startingPricePaise}
              ratePct={ratePct}
              className="text-[22px] font-extrabold tracking-[-0.02em]"
            />
            <TaxNote
              excl={`${item.startingUnit} + GST`}
              incl={`${item.startingUnit} incl. GST`}
              className="text-[13px] font-semibold text-ink-2"
            />
          </p>
        ) : null}
        <p className="mt-1 flex items-center gap-1.5 text-[13px] font-semibold leading-[21px] text-ink-2">
          <Icon name="computer" size={17} />
          <span>
            <span className="sr-only">Runs on </span>
            {platformsLabel(item.platforms)}
          </span>
        </p>

        <div className="mt-[18px] flex items-center gap-2">
          <Link
            href={href}
            className="flex-1 rounded-12 bg-primary px-3.5 py-[11px] text-center text-[14.5px] font-bold text-white no-underline transition-colors hover:bg-primary-hover hover:text-white"
          >
            View details<span className="sr-only">: {item.name}</span>
          </Link>
          {item.comingSoon ? null : (
            <label
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-12 border px-3 py-2.5 text-[14px] font-bold transition-colors",
                compared ? "border-primary-accent bg-lavender-soft" : "border-line-input bg-surface hover:border-primary",
              )}
            >
              <Checkbox
                checked={compared}
                onCheckedChange={() => onToggleCompare(item.id)}
                data-compare-id={item.id}
                className="size-[17px]"
              />
              Compare<span className="sr-only"> {item.shortName}</span>
            </label>
          )}
        </div>
      </div>
    </article>
  );
}
