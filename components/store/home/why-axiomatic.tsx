import { Icon } from "@/components/icons/icon";
import { TONE_TILE_CLASSES } from "@/components/store/active-nav";
import { Container } from "@/components/store/container";
import { SectionHeading } from "@/components/store/section-heading";
import { HOME_WHY } from "@/content/home";
import { cn } from "@/lib/utils";
import { HOME_OVERLINE_LINE, WRAP } from "./styles";

/** "Why Axiomatic": heading and lead on the left, six benefits on the right (Home.dc.html section 4). Server. */
export function WhyAxiomatic() {
  return (
    <Container as="section" aria-labelledby="why-h" className="py-[clamp(56px,7vw,96px)]">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] gap-[clamp(32px,5vw,72px)]">
        <SectionHeading
          id="why-h"
          size="display-section"
          overline={HOME_WHY.overline}
          title={HOME_WHY.title}
          lead={HOME_WHY.lead}
          overlineClassName={HOME_OVERLINE_LINE}
          leadClassName="max-w-[440px]"
        />
        <ul
          className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-x-8 gap-y-7 p-0"
        >
          {HOME_WHY.benefits.map((benefit) => (
            <li key={benefit.title}>
              <span
                aria-hidden="true"
                className={cn("grid size-[42px] place-items-center rounded-12", TONE_TILE_CLASSES[benefit.tone])}
              >
                <Icon name={benefit.icon} size={22} />
              </span>
              <h3 className={cn("mt-3.5 mb-0 text-[17px] font-extrabold tracking-[-0.01em]", WRAP)}>{benefit.title}</h3>
              <p className="mt-1.5 mb-0 text-[15px] leading-[1.6] text-ink-2">{benefit.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </Container>
  );
}
