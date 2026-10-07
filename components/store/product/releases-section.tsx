import { Icon } from "@/components/icons/icon";
import { SectionHeading } from "@/components/store/section-heading";
import type { StoreProduct } from "@/lib/storefront/types";
import { cn } from "@/lib/utils";
import { PRODUCT_COPY } from "./copy";
import { releaseDateLabel, releaseMetaLabel } from "./model";
import { ProductSection } from "./product-section";
import { ReleaseHistory } from "./release-history";
import { PRODUCT_TONES } from "./tones";

/**
 * Releases: the latest published release (version, IST date, installer size, notes) and, when there are older ones,
 * the collapsible "Earlier versions" list. Renders nothing for a product without a published release.
 */
export function ReleasesSection({ product }: { product: StoreProduct }) {
  const [latest, ...older] = product.releases;
  if (!latest) return null;
  const t = PRODUCT_TONES[product.tone];

  return (
    <ProductSection id="releases" labelledBy="releases-title">
      <SectionHeading
        id="releases-title"
        title={PRODUCT_COPY.releasesTitle}
        titleClassName="leading-[normal]"
        lead={PRODUCT_COPY.releasesLead}
        leadClassName="max-w-[560px]"
      />
      <div className="mt-7 overflow-hidden rounded-22 border border-line bg-surface">
        <div
          className={cn(
            "grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-6 p-7",
            t.soft,
            older.length > 0 && "border-b border-line",
          )}
        >
          <div>
            <div className="flex items-center gap-2.5">
              <h3 className="m-0 text-[30px] font-extrabold tracking-[-0.03em]">v{latest.version}</h3>
              <span className="rounded-pill bg-sage-bg px-2.5 py-1 text-[12.5px] font-extrabold text-sage-fg">
                {PRODUCT_COPY.latest}
              </span>
            </div>
            <p className="m-0 mt-1.5 text-[14px] font-semibold text-ink-2">{releaseMetaLabel(latest)}</p>
          </div>
          {latest.notes.length > 0 ? (
            <ul className="m-0 grid list-none content-center gap-2 p-0 text-[15px] font-semibold">
              {latest.notes.map((note) => (
                <li key={note} className="flex gap-2.5">
                  <Icon name="check" size={19} className={cn("my-0.5", t.fg)} />
                  {note}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {older.length > 0 ? (
          <div className="px-7 pb-2.5 pt-1.5">
            <h3 className="m-0 pb-1.5 pt-3.5 text-[12.5px] font-extrabold uppercase tracking-[0.1em] text-ink-2">
              {PRODUCT_COPY.earlierVersions}
            </h3>
            <ReleaseHistory
              releases={older.map((r) => ({ version: r.version, dateLabel: releaseDateLabel(r), notes: r.notes }))}
            />
          </div>
        ) : null}
      </div>
    </ProductSection>
  );
}
