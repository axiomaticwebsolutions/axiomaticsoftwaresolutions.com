import { Icon } from "@/components/icons/icon";
import { Container } from "@/components/store/container";
import { SectionHeading } from "@/components/store/section-heading";
import { HOME_HOW } from "@/content/home";
import { cn } from "@/lib/utils";
import { HOME_OVERLINE_LINE, HOME_TONE_CLASSES, ICON_LINE_BOX, WRAP } from "./styles";

/** Dark "Purchase, download, activate" band with three steps and the payment-confirmation note. Server. */
export function HowItWorks() {
  return (
    <Container as="section" aria-labelledby="how-h" className="pb-[clamp(56px,7vw,96px)]">
      <div className="rounded-32 bg-ink p-[clamp(32px,5vw,64px)] text-white">
        <SectionHeading
          id="how-h"
          size="band"
          tone="onDark"
          overline={HOME_HOW.overline}
          title={HOME_HOW.title}
          overlineClassName={HOME_OVERLINE_LINE}
          titleClassName={WRAP}
        />
        <ol
          className="m-0 mt-10 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-5 p-0"
        >
          {HOME_HOW.steps.map((step, i) => (
            <li key={step.title} className="rounded-22 border border-white/10 bg-white/6 p-[26px]">
              <div className="flex items-center justify-between">
                <span
                  aria-hidden="true"
                  className={cn("grid size-[46px] place-items-center rounded-14 text-ink", HOME_TONE_CLASSES[step.tone].bg)}
                >
                  <Icon name={step.icon} size={24} />
                </span>
                <span className="font-mono text-[13px] text-white/65 uppercase">
                  {HOME_HOW.stepLabel} {i + 1}
                </span>
              </div>
              <h3 className={cn("mt-[22px] mb-0 text-[19px] font-extrabold", WRAP)}>{step.title}</h3>
              <p className="mt-2 mb-0 text-[15px] leading-[1.6] text-admin-text">{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-7 mb-0 flex items-start gap-2 text-[14.5px] text-admin-text">
          <Icon name="verified_user" size={19} className={cn("text-success-soft", ICON_LINE_BOX[19])} />
          {HOME_HOW.note}
        </p>
      </div>
    </Container>
  );
}
