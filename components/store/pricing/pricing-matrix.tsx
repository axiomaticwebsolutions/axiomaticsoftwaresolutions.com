import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { TONE_TILE_CLASSES } from "@/components/store/active-nav";
import { Price, PriceVariants } from "@/components/store/price";
import { PRICING_MATRIX } from "@/content/pricing";
import { cn } from "@/lib/utils";
import { PRICING_COLUMN_KEYS, formatRate, type MatrixCell, type MatrixRow } from "./pricing-model";

export type PricingMatrixProps = {
  rows: readonly MatrixRow[];
  /** settings tax.gstRatePct (the incl. GST prices and the caption). */
  ratePct: number;
  /** Prefix the footnote with "Sample prices for this prototype …" (while the sample notice is on). */
  sampleNote: boolean;
  className?: string;
};

const CAPTION_ID = "pricing-matrix-caption";

function Cell({ cell, ratePct }: { cell: MatrixCell; ratePct: number }) {
  if (!cell.offered) {
    return (
      <>
        {/* Decision: contrast-safe dash (ink-3) instead of the prototype's #9AA3B2. */}
        <span aria-hidden="true" className="font-bold text-ink-3">
          —
        </span>
        <span className="sr-only">{PRICING_MATRIX.notOffered}</span>
      </>
    );
  }
  return (
    <>
      <div className="font-extrabold">
        {cell.free ? PRICING_MATRIX.free : <Price paise={cell.pricePaise} ratePct={ratePct} />}
      </div>
      <div className="text-[12.5px] font-semibold text-ink-2">{cell.unit}</div>
    </>
  );
}

/**
 * "Which licenses each product offers": one row per product, the starting price of each license type, or a dash.
 * Both price variants render; <html data-price> shows one (components/store/price.tsx). The table keeps its 820px
 * minimum and scrolls inside its card on narrow screens (a focusable, labelled region for keyboard users).
 */
export function PricingMatrix({ rows, ratePct, sampleNote, className }: PricingMatrixProps) {
  const rate = formatRate(ratePct);
  return (
    <div className={cn("overflow-hidden rounded-24 border border-line bg-surface", className)}>
      <div
        role="region"
        aria-labelledby={CAPTION_ID}
        // A scrolling region must be reachable by keyboard (WCAG 2.1.1; axe scrollable-region-focusable).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        // relative: the sr-only "Not offered" labels are absolutely positioned; this keeps them inside the scroller.
        className="relative overflow-x-auto rounded-t-24 focus-visible:outline-offset-[-2px]"
      >
        <table className="w-full min-w-[820px] border-collapse text-[15px] leading-[normal]">
          <caption
            id={CAPTION_ID}
            className="border-b border-line-subtle px-[22px] py-[18px] text-left text-[17px] font-extrabold"
          >
            {/* One text node: a separate {" "} after React's comment marker is dropped from Chrome's accessible name. */}
            {`${PRICING_MATRIX.caption} `}
            <PriceVariants
              className="text-[14px] font-semibold text-ink-2"
              excl={PRICING_MATRIX.captionExcl}
              incl={PRICING_MATRIX.captionIncl(rate)}
            />
          </caption>
          <thead>
            <tr className="bg-bg text-left text-[12.5px] uppercase tracking-[0.06em] text-ink-2">
              <th scope="col" className="px-[22px] py-[14px] font-extrabold">
                {PRICING_MATRIX.productColumn}
              </th>
              {PRICING_COLUMN_KEYS.map((key) => (
                <th key={key} scope="col" className="px-3 py-[14px] text-center font-extrabold">
                  {PRICING_MATRIX.columns[key]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-line-subtle">
                <th scope="row" className="px-[22px] py-4 text-left">
                  <Link
                    href={row.href}
                    className="flex items-center gap-3 rounded-10 text-ink no-underline hover:text-primary-link-hover"
                  >
                    <span
                      aria-hidden="true"
                      className={cn("grid size-[38px] shrink-0 place-items-center rounded-[11px]", TONE_TILE_CLASSES[row.tone])}
                    >
                      <Icon name={row.icon} size={21} />
                    </span>
                    <span className="font-extrabold">{row.name}</span>
                  </Link>
                </th>
                {row.cells.map((cell) => (
                  <td key={cell.key} className="px-3 py-4 text-center">
                    <Cell cell={cell} ratePct={ratePct} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="m-0 border-t border-line-subtle px-[22px] py-[14px] text-[13.5px] font-semibold leading-[normal] text-ink-2">
        {sampleNote ? `${PRICING_MATRIX.sampleNote} ` : null}
        {PRICING_MATRIX.dashNote}
      </p>
    </div>
  );
}
