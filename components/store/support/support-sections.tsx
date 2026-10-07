import Link from "next/link";
import type * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";
import { TONE_TILE_CLASSES } from "@/components/store/active-nav";
import { Container } from "@/components/store/container";
import { SectionHeading } from "@/components/store/section-heading";
import { telHref } from "@/components/store/site-footer";
import { Button } from "@/components/ui/button";
import { RAISE_TICKET_HREF, SUPPORT_CHANNELS, SUPPORT_HERO, SUPPORT_TASKS } from "@/content/support";
import type { BusinessSettings } from "@/lib/config";
import { cn } from "@/lib/utils";

// Support.dc.html section headings: clamp(24px,2.6vw,30px), -0.03em, line-height normal.
const HEADING_CLASS = "text-[clamp(24px,2.6vw,30px)] leading-[normal]";

/** Popular topic chips under the hero search (links to guides). Server-safe. */
export function SupportPopularTopics() {
  return (
    <nav aria-label={SUPPORT_HERO.popularLabel}>
      <ul className="m-0 mt-3.5 flex list-none flex-wrap justify-center gap-2 p-0 text-[13.5px] font-bold leading-[normal]">
        {SUPPORT_HERO.popular.map((topic) => (
          <li key={topic.href}>
            <Link
              href={topic.href}
              className="inline-block rounded-pill bg-surface px-3 py-1.5 text-sage-fg no-underline transition-colors hover:bg-sage-soft hover:underline"
            >
              {topic.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** "Do it yourself": six link cards into the portal and the guides. Server-safe. */
export function SupportTasks() {
  return (
    <Container as="section" aria-labelledby="support-tasks-title" className="py-[clamp(40px,5vw,64px)] leading-[normal]">
      <SectionHeading id="support-tasks-title" size="compact" title={SUPPORT_TASKS.title} titleClassName={HEADING_CLASS} />
      <ul className="m-0 mt-5 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,250px),1fr))] gap-3.5 p-0">
        {SUPPORT_TASKS.items.map((task) => (
          <li key={task.title} className="grid">
            <Link
              href={task.href}
              className="grid content-start gap-2.5 rounded-20 border border-line bg-surface p-5 text-ink no-underline transition-colors hover:border-primary-accent"
            >
              <span aria-hidden="true" className={cn("grid size-[42px] place-items-center rounded-12", TONE_TILE_CLASSES[task.tone])}>
                <Icon name={task.icon} size={22} />
              </span>
              <span className="text-[16px] font-extrabold">{task.title}</span>
              <span className="text-[14px] leading-[1.55] text-ink-2">{task.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Container>
  );
}

type ChannelCardProps = {
  tone: "lavender" | "blue" | "peach";
  icon: IconName;
  title: string;
  body: React.ReactNode;
  sla: string;
  children?: React.ReactNode;
};

const CHANNEL_TONES = {
  lavender: { card: "bg-lavender-bg", fg: "text-lavender-fg" },
  blue: { card: "bg-blue-bg", fg: "text-blue-fg" },
  peach: { card: "bg-peach-bg", fg: "text-peach-fg" },
} as const;

function ChannelCard({ tone, icon, title, body, sla, children }: ChannelCardProps) {
  const t = CHANNEL_TONES[tone];
  return (
    <li className={cn("grid content-start gap-2 rounded-20 p-[22px]", t.card)}>
      {/* The prototype icon is a 26px font glyph in a 32px line box. */}
      <span className={cn("flex h-8 items-center", t.fg)}>
        <Icon name={icon} size={26} />
      </span>
      <h3 className="m-0 text-[17px] font-extrabold leading-[normal]">{title}</h3>
      <p className="m-0 break-words text-[14.5px] leading-[1.55] text-ink-soft">{body}</p>
      <p className={cn("m-0 text-[13.5px] font-bold", t.fg)}>{sla}</p>
      {children}
    </li>
  );
}

/** "Contact support": ticket, email and phone cards with hours and contacts from settings.business. Server-safe. */
export function SupportChannels({ business }: { business: BusinessSettings }) {
  const tel = business.sample ? null : telHref(business.phone);
  return (
    <section aria-labelledby="support-channels-title" className="border-y border-line-subtle bg-surface leading-[normal]">
      <Container className="py-[clamp(40px,5vw,64px)]">
        <SectionHeading
          id="support-channels-title"
          size="compact"
          title={SUPPORT_CHANNELS.title}
          titleClassName={HEADING_CLASS}
          lead={SUPPORT_CHANNELS.intro(business.hours, business.sample)}
          leadClassName="mt-1.5 max-w-none text-[15.5px] leading-[normal]"
        />
        <ul className="m-0 mt-5 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] gap-3.5 p-0">
          <ChannelCard
            tone="lavender"
            icon="confirmation_number"
            title={SUPPORT_CHANNELS.ticket.title}
            body={SUPPORT_CHANNELS.ticket.body}
            sla={SUPPORT_CHANNELS.ticket.sla}
          >
            <Button asChild className="mt-1.5 justify-self-start px-4 text-base leading-[normal]">
              <Link href={RAISE_TICKET_HREF}>{SUPPORT_CHANNELS.ticket.cta}</Link>
            </Button>
          </ChannelCard>
          <ChannelCard
            tone="blue"
            icon="mail"
            title={SUPPORT_CHANNELS.email.title}
            body={
              <>
                <a href={`mailto:${business.supportEmail}`} className="text-ink-soft underline-offset-2 hover:text-blue-fg hover:underline">
                  {business.supportEmail}
                </a>
                {SUPPORT_CHANNELS.email.bodyAfterAddress}
              </>
            }
            sla={SUPPORT_CHANNELS.email.sla}
          />
          <ChannelCard
            tone="peach"
            icon="call"
            title={SUPPORT_CHANNELS.phone.title}
            body={
              <>
                {tel ? (
                  <a href={tel} className="text-ink-soft underline-offset-2 hover:text-peach-fg hover:underline">
                    {business.phone}
                  </a>
                ) : (
                  business.phone
                )}
                {SUPPORT_CHANNELS.phone.bodyAfterNumber(business.sample)}
              </>
            }
            sla={SUPPORT_CHANNELS.phone.sla}
          />
        </ul>
      </Container>
    </section>
  );
}
