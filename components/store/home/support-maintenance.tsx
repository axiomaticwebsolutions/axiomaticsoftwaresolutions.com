import Link from "next/link";
import type * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";
import { Container } from "@/components/store/container";
import { SectionHeading } from "@/components/store/section-heading";
import { HOME_MAINTENANCE, HOME_SUPPORT, maintenanceBody } from "@/content/home";
import { cn } from "@/lib/utils";
import { HOME_OVERLINE_LINE, ICON_LINE_BOX, WRAP } from "./styles";

export type SupportAndMaintenanceProps = {
  /** Support hours from settings (business.hours), e.g. "Mon–Sat, 10:00–19:00 IST". */
  hours: string;
  /** True while the business details are placeholders: adds "(configurable)" after the hours. */
  sample: boolean;
  /** Months of updates a one-time license includes (Plan.updatesMonths). */
  updatesMonths: number;
};

/** Card heading metrics shared by both cards: clamp(26px,2.8vw,34px)/1.15, overline in the card's tone. */
const CARD_TITLE = cn("text-[clamp(26px,2.8vw,34px)] leading-[1.15] tracking-[-0.03em]", WRAP);
const CARD_LEAD = "mt-3.5 max-w-none text-[16px] leading-[1.6] text-ink-soft";
const CARD = "rounded-28 p-[clamp(28px,4vw,44px)]";

/** Sage support card and peach maintenance card side by side (Home.dc.html section 6). Server. */
export function SupportAndMaintenance({ hours, sample, updatesMonths }: SupportAndMaintenanceProps) {
  return (
    <Container className="pb-[clamp(56px,7vw,96px)]">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,380px),1fr))] gap-5">
        <section aria-labelledby="sup-h" className={cn(CARD, "bg-sage-bg")}>
          <SectionHeading
            id="sup-h"
            overline={HOME_SUPPORT.overline}
            title={HOME_SUPPORT.title}
            lead={HOME_SUPPORT.body}
            overlineClassName={cn("text-sage-fg", HOME_OVERLINE_LINE)}
            titleClassName={CARD_TITLE}
            leadClassName={CARD_LEAD}
          />
          <ul className="m-0 mt-6 grid list-none gap-3 p-0 text-[15px] font-semibold">
            <SupportRow icon="confirmation_number">{HOME_SUPPORT.tickets}</SupportRow>
            <SupportRow icon="schedule">
              <span>{hours}</span>
              {sample ? <span className="text-[12px] font-semibold text-ink-2">{HOME_SUPPORT.configurable}</span> : null}
            </SupportRow>
            <SupportRow icon="menu_book">{HOME_SUPPORT.guides}</SupportRow>
          </ul>
          <Link
            href={HOME_SUPPORT.href}
            className="mt-6 inline-block font-bold text-sage-fg underline underline-offset-[3px] hover:decoration-2"
          >
            {HOME_SUPPORT.link} <span aria-hidden="true">→</span>
          </Link>
        </section>

        <section aria-labelledby="maint-h" className={cn(CARD, "bg-peach-bg")}>
          <SectionHeading
            id="maint-h"
            overline={HOME_MAINTENANCE.overline}
            title={HOME_MAINTENANCE.title}
            lead={maintenanceBody(updatesMonths)}
            overlineClassName={cn("text-peach-fg", HOME_OVERLINE_LINE)}
            titleClassName={CARD_TITLE}
            leadClassName={CARD_LEAD}
          />
          <ul className="m-0 mt-5 grid list-none gap-2.5 p-0 text-[15px] font-semibold">
            {HOME_MAINTENANCE.items.map((item) => (
              <li key={item} className="flex gap-2.5">
                <Icon name="check" size={20} className={cn("text-peach-fg", ICON_LINE_BOX[20])} />
                {item}
              </li>
            ))}
          </ul>
          <Link
            href={HOME_MAINTENANCE.href}
            className="mt-6 inline-block font-bold text-peach-fg underline underline-offset-[3px] hover:decoration-2"
          >
            {HOME_MAINTENANCE.link} <span aria-hidden="true">→</span>
          </Link>
        </section>
      </div>
    </Container>
  );
}

function SupportRow({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-14 bg-white px-4 py-3.5">
      <Icon name={icon} size={21} className={cn("text-sage-fg", ICON_LINE_BOX[21])} />
      {children}
    </li>
  );
}
