import Link from "next/link";
import type * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";
import {
  avgOrderText,
  expiringSoonText,
  openTicketsText,
  revenueDelta,
  rupeesWhole,
  type OverviewData,
} from "@/lib/admin/overview/model";
import type { Tone } from "@/lib/design/tokens";
import { cn } from "@/lib/utils";

/** Tone backgrounds and foregrounds (static class names for Tailwind). */
export const TONE_BG: Readonly<Record<Tone, string>> = {
  lavender: "bg-lavender-bg",
  sage: "bg-sage-bg",
  blue: "bg-blue-bg",
  peach: "bg-peach-bg",
  pink: "bg-pink-bg",
};
export const TONE_FG: Readonly<Record<Tone, string>> = {
  lavender: "text-lavender-fg",
  sage: "text-sage-fg",
  blue: "text-blue-fg",
  peach: "text-peach-fg",
  pink: "text-pink-fg",
};

export type KpiCard = {
  key: string;
  label: string;
  icon: IconName;
  tone: Tone;
  value: string;
  sub: React.ReactNode;
  /** Module the card opens; null when the role cannot open it (the card is not a link then). */
  href: string | null;
};

export type OverviewLinks = { reports: boolean; orders: boolean; licenses: boolean; renewals: boolean; tickets: boolean; audit: boolean };

const count = (n: number) => n.toLocaleString("en-IN");

function RevenueDelta({ kpis, range }: { kpis: OverviewData["kpis"]; range: OverviewData["range"] }) {
  const delta = revenueDelta(kpis.revenue.deltaPct, range);
  if (!delta.direction) return <>{delta.text}</>;
  return (
    <>
      <span aria-hidden="true">{delta.direction === "up" ? "\u25B2 " : "\u25BC "}</span>
      <span className="sr-only">{delta.direction === "up" ? "Up " : "Down "}</span>
      {delta.text}
    </>
  );
}

/** The five prototype KPIs: revenue, paid orders, needs attention, active licenses and open tickets. */
export function overviewKpis(data: OverviewData, links: OverviewLinks): KpiCard[] {
  const k = data.kpis;
  return [
    { key: "revenue", label: "Revenue", icon: "payments", tone: "sage", value: rupeesWhole(k.revenue.paise), sub: <RevenueDelta kpis={k} range={data.range} />, href: links.reports ? "/admin/reports" : null },
    { key: "paid", label: "Paid orders", icon: "receipt_long", tone: "lavender", value: count(k.paidOrders.count), sub: avgOrderText(k.paidOrders.avgPaise), href: links.orders ? "/admin/orders" : null },
    { key: "attention", label: "Needs attention", icon: "pending_actions", tone: "peach", value: count(k.needsAttention), sub: "Pending or in-review payments", href: links.orders ? "/admin/orders" : null },
    { key: "licenses", label: "Active licenses", icon: "key", tone: "blue", value: count(k.activeLicenses.count), sub: expiringSoonText(k.activeLicenses.expiringSoon), href: links.licenses ? "/admin/licenses" : null },
    { key: "tickets", label: "Open tickets", icon: "support_agent", tone: "pink", value: count(k.openTickets.count), sub: openTicketsText(k.openTickets.high, k.openTickets.unassigned), href: links.tickets ? "/admin/tickets" : null },
  ];
}

const CARD = "grid gap-1.5 rounded-14 border border-line-alt bg-surface px-4 py-3.5 text-ink no-underline";

function KpiCardView({ card }: { card: KpiCard }) {
  const body = (
    <>
      <span className="flex items-center justify-between gap-2">
        <span className="text-[11.5px] font-extrabold uppercase tracking-[0.07em] text-ink-2">{card.label}</span>
        <span aria-hidden="true" className={cn("grid size-7 shrink-0 place-items-center rounded-8", TONE_BG[card.tone], TONE_FG[card.tone])}>
          <Icon name={card.icon} size={17} />
        </span>
      </span>
      <span className="text-[24px] font-extrabold leading-[normal] tracking-[-0.02em] tabular-nums">{card.value}</span>
      <span className="text-[12px] font-semibold text-ink-2">{card.sub}</span>
    </>
  );
  if (!card.href) return <div className={CARD}>{body}</div>;
  return (
    <Link href={card.href} className={cn(CARD, "transition-colors hover:border-primary-accent hover:text-ink")}>
      {body}
    </Link>
  );
}

/** KPI cards (prototype: auto-fit at 200px, 12px gap). A list, so screen readers announce five items. */
export function KpiCards({ data, links }: { data: OverviewData; links: OverviewLinks }) {
  return (
    <ul aria-label="Key figures" className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-3 p-0">
      {overviewKpis(data, links).map((card) => (
        <li key={card.key} className="grid min-w-0">
          <KpiCardView card={card} />
        </li>
      ))}
    </ul>
  );
}
