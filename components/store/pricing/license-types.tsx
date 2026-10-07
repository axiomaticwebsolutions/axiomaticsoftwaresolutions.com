import { Icon } from "@/components/icons/icon";
import { TONE_TILE_CLASSES } from "@/components/store/active-nav";
import { Container } from "@/components/store/container";
import { SectionHeading } from "@/components/store/section-heading";
import { LICENSE_TYPES_COPY, type LicenseTypeCopy } from "@/content/pricing";
import { cn } from "@/lib/utils";

const HEADING_ID = "license-types-heading";

/** #types: "License types, in plain words", six cards with Updates / When it ends / Best for. */
export function LicenseTypes({ cards }: { cards: readonly LicenseTypeCopy[] }) {
  const { terms } = LICENSE_TYPES_COPY;
  return (
    <section
      id="types"
      aria-labelledby={HEADING_ID}
      className="scroll-mt-2.5 border-y border-line-subtle bg-surface"
    >
      <Container className="py-[clamp(48px,6vw,80px)]">
        <SectionHeading id={HEADING_ID} title={LICENSE_TYPES_COPY.heading} titleClassName="leading-[normal]" />
        <div className="mt-7 grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-4">
          {cards.map((card) => (
            <article key={card.key} className="grid content-start gap-3 rounded-22 border border-line p-6">
              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className={cn("grid size-11 shrink-0 place-items-center rounded-13", TONE_TILE_CLASSES[card.tone])}
                >
                  <Icon name={card.icon} size={23} />
                </span>
                <h3 className="m-0 text-[19px] font-extrabold leading-[normal]">{card.name}</h3>
              </div>
              <p className="m-0 text-[15.5px] leading-[1.6] text-ink-soft">{card.what}</p>
              <dl className="m-0 grid gap-2 text-[14.5px] leading-[normal]">
                {(
                  [
                    [terms.updates, card.updates],
                    [terms.ends, card.ends],
                    [terms.bestFor, card.bestFor],
                  ] as const
                ).map(([term, value]) => (
                  <div key={term} className="grid grid-cols-[120px_1fr] gap-2.5">
                    <dt className="font-extrabold text-ink-2">{term}</dt>
                    <dd className="m-0">{value}</dd>
                  </div>
                ))}
              </dl>
            </article>
          ))}
        </div>
      </Container>
    </section>
  );
}
