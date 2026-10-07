import Link from "next/link";
import type * as React from "react";
import { Icon } from "@/components/icons/icon";
import { licensePath, PORTAL_PATHS } from "@/components/account/portal-nav";
import type { AccountOverview, OverviewAlert } from "@/lib/portal/overview";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { CALLOUT_CTA_CLASS, PortalCallout } from "./callout";
import {
  activityLine,
  alertAction,
  alertMoreText,
  dotLeft,
  kpiCards,
  moreText,
  OVERVIEW_COPY,
  renewalPrice,
  renewalWhen,
  slotAriaLabel,
  slotBar,
  slotLabel,
  timelineAriaLabel,
  timelineDotTitle,
  type KpiCard,
} from "./model";
import { RenewToCartButton } from "./renew-button";
import { TONE_CLASSES, toneClasses } from "./tones";

/** Card link in the prototype's plain link style (#5547C2, underlined, 13px/700). */
const CARD_LINK = "rounded-6 text-[13px] font-bold text-primary-link underline hover:text-primary-link-hover";
const OUTLINE_SMALL =
  "cursor-pointer rounded-9 border border-line-input bg-surface px-3 py-[7px] text-[13px] font-bold leading-[normal] text-ink transition-colors hover:border-primary";

export type OverviewViewProps = {
  overview: AccountOverview;
  /** Request time (relative activity times are computed on the server, once). */
  now: Date;
};

/**
 * Overview (Customer Portal.dc.html vOverview), rendered on the server: alerts, four KPI link cards, then a grid of
 * section cards (device-slot utilization, renewals over the next 12 months, spend by product and, for Owners, recent
 * activity). Only the renewal buttons are client components (cart).
 */
export function OverviewView({ overview, now }: OverviewViewProps) {
  return (
    <div className="grid animate-enter-up gap-4">
      {overview.alerts.map((alert) => (
        <AlertCard key={`${alert.kind}:${alert.licenseId ?? alert.ticketId ?? ""}`} alert={alert} />
      ))}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,210px),1fr))] gap-3.5">
        {kpiCards(overview.kpis).map((card) => (
          <KpiLink key={card.key} card={card} />
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-4">
        <UtilizationCard overview={overview} />
        <RenewalsCard overview={overview} />
        <SpendCard overview={overview} />
        {overview.recentActivity ? <ActivityCard rows={overview.recentActivity} now={now} /> : null}
      </div>
    </div>
  );
}

function AlertCard({ alert }: { alert: OverviewAlert }) {
  const action = alertAction(alert);
  return (
    <PortalCallout
      tone={alert.tone}
      icon={alert.icon}
      title={alert.title}
      body={alert.body}
      extra={alertMoreText(alert)}
      actions={
        action.type === "renewal" ? (
          <RenewToCartButton
            licenseId={action.licenseId}
            renewal={action.renewal}
            srSuffix={` ${action.licenseId}`}
            className={CALLOUT_CTA_CLASS}
          >
            {action.label}
          </RenewToCartButton>
        ) : (
          <Link href={action.href} className={CALLOUT_CTA_CLASS}>
            {action.label}
          </Link>
        )
      }
    />
  );
}

function KpiLink({ card }: { card: KpiCard }) {
  return (
    <Link
      href={card.href}
      className="grid gap-2 rounded-16 border border-line-alt bg-surface px-[18px] py-4 text-ink no-underline transition-colors hover:border-primary-accent hover:text-ink"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-extrabold uppercase tracking-[0.06em] text-ink-2">{card.label}</span>
        <span aria-hidden="true" className={cn("grid size-[30px] shrink-0 place-items-center rounded-9", TONE_CLASSES[card.tone].tile)}>
          <Icon name={card.icon} size={18} />
        </span>
      </span>
      <span className="text-[26px] font-extrabold leading-none tracking-[-0.02em]">{card.value}</span>
      <span className="text-[12.5px] font-semibold text-ink-2">{card.sub}</span>
    </Link>
  );
}

function SectionCard({
  id,
  title,
  aside,
  children,
}: {
  id: string;
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="rounded-16 border border-line-alt bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-[18px] py-3.5">
        <h2 id={id} className="m-0 text-[15px] font-extrabold">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function UtilizationCard({ overview }: { overview: AccountOverview }) {
  const { rows, more } = overview.utilization;
  const extra = moreText(more, "license");
  return (
    <SectionCard
      id="ov-utilization"
      title={OVERVIEW_COPY.utilization}
      aside={
        <Link href={PORTAL_PATHS.devices} className={CARD_LINK}>
          {OVERVIEW_COPY.allDevices}
        </Link>
      }
    >
      <div className="px-[18px] pb-4 pt-2">
        {rows.length === 0 ? <p className="m-0 mt-2.5 text-[14px] text-ink-2">{OVERVIEW_COPY.noUtilization}</p> : null}
        {rows.length > 0 ? (
          <ul className="m-0 list-none p-0">
            {rows.map((row) => (
              <li key={row.licenseId}>
                <Link href={licensePath(row.licenseId)} className="block rounded-6 py-2.5 text-ink no-underline hover:text-ink">
                  <span className="flex justify-between gap-3 text-[13.5px] font-bold">
                    <span className="min-w-0">
                      {row.productShortName} <span className="font-semibold text-ink-2">{`\u00b7 ${row.licenseId}`}</span>
                    </span>
                    <span className="shrink-0">
                      <span aria-hidden="true">{slotLabel(row)}</span>
                      <span className="sr-only">{`, ${slotAriaLabel(row)}`}</span>
                    </span>
                  </span>
                  <SlotSegments row={row} />
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
        {extra ? (
          <Link href={PORTAL_PATHS.devices} className={cn(CARD_LINK, "mt-1.5 inline-block")}>
            {extra}
          </Link>
        ) : null}
      </div>
    </SectionCard>
  );
}

function SlotSegments({ row }: { row: AccountOverview["utilization"]["rows"][number] }) {
  const bar = slotBar(row);
  return (
    <span aria-hidden="true" className="mt-[7px] flex h-2 gap-0.5 overflow-hidden rounded-pill bg-line-subtle forced-color-adjust-none">
      {bar.mode === "cells" ? (
        bar.cells.map((cell, i) => (
          <span
            // Cells are positional and never reorder.
            key={i}
            className={cn("flex-1", cell === "used" && "bg-primary", cell === "full" && "bg-warn-bar", cell === "free" && "bg-line-alt")}
          />
        ))
      ) : (
        <span className={cn("h-full", bar.full ? "bg-warn-bar" : "bg-primary")} style={{ width: `${bar.pct}%` }} />
      )}
    </span>
  );
}

function RenewalsCard({ overview }: { overview: AccountOverview }) {
  const { months, items, more } = overview.renewals;
  const extra = moreText(more, "renewal");
  return (
    <SectionCard
      id="ov-renewals"
      title={OVERVIEW_COPY.renewals}
      aside={
        <Link href={PORTAL_PATHS.licenses} className={CARD_LINK}>
          {OVERVIEW_COPY.licenses}
        </Link>
      }
    >
      <div className="px-[18px] py-4">
        <div role="img" aria-label={timelineAriaLabel(items)} className="relative h-[46px]">
          <span className="absolute inset-x-0 top-5 h-1.5 rounded-pill bg-line-subtle" />
          <span className="absolute inset-x-0 top-8 flex justify-between text-[11px] font-bold text-ink-3">
            {months.map((m) => (
              <span key={m.key}>{m.label}</span>
            ))}
          </span>
          {items.map((item) => (
            <span
              key={item.licenseId}
              title={timelineDotTitle(item)}
              className={cn(
                "absolute top-3 -ml-[11px] size-[22px] rounded-full border-[3px] border-surface ring-1",
                item.soon ? "bg-warn-bar ring-peach-line" : "bg-primary ring-lavender-line",
              )}
              style={{ left: dotLeft(item.positionPct) }}
            />
          ))}
        </div>
        <div className="mt-3.5 grid">
          {items.length === 0 ? <p className="m-0 text-[14px] text-ink-2">{OVERVIEW_COPY.noRenewals}</p> : null}
          {items.map((item) => (
            <div key={item.licenseId} className="flex items-center gap-3 border-t border-line-subtle py-2.5 max-[29.99rem]:flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-bold">{`${item.productShortName} \u00b7 ${item.planName}`}</div>
                <div className={cn("text-[12.5px] font-bold", item.soon ? "text-peach-fg" : "text-ink-2")}>{renewalWhen(item)}</div>
              </div>
              {item.renewal ? (
                <>
                  <div className="text-[14px] font-extrabold">{renewalPrice(item.renewal)}</div>
                  <RenewToCartButton licenseId={item.licenseId} renewal={item.renewal} srSuffix={` ${item.licenseId}`} className={OUTLINE_SMALL}>
                    {OVERVIEW_COPY.renew}
                  </RenewToCartButton>
                </>
              ) : null}
            </div>
          ))}
          {extra ? (
            <Link href={PORTAL_PATHS.licenses} className={cn(CARD_LINK, "mt-1 justify-self-start")}>
              {extra}
            </Link>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

function SpendCard({ overview }: { overview: AccountOverview }) {
  const rows = overview.spendByProduct;
  return (
    <SectionCard
      id="ov-spend"
      title={OVERVIEW_COPY.spend}
      aside={<span className="text-right text-[12.5px] font-semibold text-ink-2">{OVERVIEW_COPY.spendCaption}</span>}
    >
      {rows.length === 0 ? (
        <p className="m-0 px-[18px] pb-4 pt-3 text-[14px] text-ink-2">{OVERVIEW_COPY.noSpend}</p>
      ) : (
        <ul className="m-0 grid list-none gap-3 px-[18px] pb-4 pt-3">
          {rows.map((row) => (
            <li key={row.productId}>
              <div className="flex justify-between gap-3 text-[13.5px] font-bold">
                <span className="min-w-0">{row.productShortName}</span>
                <span className="shrink-0">{formatINR(row.amountPaise)}</span>
              </div>
              <div aria-hidden="true" className="mt-1.5 h-2.5 overflow-hidden rounded-6 bg-slate-bg forced-color-adjust-none">
                <div className={cn("h-full rounded-6", toneClasses(row.tone).bar)} style={{ width: `${row.barPct}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function ActivityCard({ rows, now }: { rows: NonNullable<AccountOverview["recentActivity"]>; now: Date }) {
  return (
    <SectionCard
      id="ov-activity"
      title={OVERVIEW_COPY.activity}
      aside={
        <Link href={PORTAL_PATHS.activity} className={CARD_LINK}>
          {OVERVIEW_COPY.activityLog}
        </Link>
      }
    >
      {rows.length === 0 ? (
        <p className="m-0 px-[18px] pb-4 pt-3 text-[14px] text-ink-2">{OVERVIEW_COPY.noActivity}</p>
      ) : (
        <ol className="m-0 list-none px-[18px] pb-3 pt-1.5">
          {rows.map((row) => {
            const line = activityLine(row, now);
            return (
              <li key={line.id} className="flex gap-2.5 border-b border-line-subtle py-[9px] text-[13.5px]">
                <span aria-hidden="true" className={cn("grid size-[26px] flex-none place-items-center rounded-8", TONE_CLASSES[line.tone].tile)}>
                  <Icon name={line.icon} size={16} />
                </span>
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <strong className="font-bold">{line.actor}</strong> {line.action}{" "}
                  <span className="text-ink-2">{`\u00b7 ${line.target}`}</span>
                </span>
                <time dateTime={line.dateTime} title={line.at} className="whitespace-nowrap text-[12.5px] font-semibold text-ink-3">
                  {line.when}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </SectionCard>
  );
}
