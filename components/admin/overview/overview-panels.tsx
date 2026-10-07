import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import {
  barPercent,
  OVERVIEW_COPY,
  paymentStatusLabel,
  webhookLine,
  rupeesWhole,
  type OverviewData,
} from "@/lib/admin/overview/model";
import { ScrollRegion } from "@/components/ui/scroll-region";
import { formatDateTimeIST } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { LICENSE_HEALTH_COLORS, PAYMENT_STATUS_COLORS, toneBar } from "./chart-colors";
import { TONE_BG, TONE_FG, type OverviewLinks } from "./kpi-cards";
import { DashboardPanel, PanelLink } from "./panel";

// Bars keep their colours in forced colours (Windows contrast themes), which would otherwise drop every background.
const TRACK = "overflow-hidden rounded-pill bg-line-subtle forced-color-adjust-none";

/** Orders created in the range by payment status: stacked bar, legend with counts, webhook results. */
export function PaymentStatusPanel({ data, links }: { data: OverviewData; links: OverviewLinks }) {
  const segments = data.paymentStatus;
  return (
    <DashboardPanel
      id="ov-payments"
      title={OVERVIEW_COPY.paymentStatus}
      aside={<PanelLink href="/admin/orders" show={links.orders}>{OVERVIEW_COPY.ordersLink}</PanelLink>}
      bodyClassName="grid gap-3 p-4"
    >
      {segments.length > 0 ? (
        <>
          <div role="img" aria-label={paymentStatusLabel(segments)} className="flex h-3.5 gap-0.5 overflow-hidden rounded-pill forced-color-adjust-none">
            {segments.map((s) => (
              <span key={s.key} style={{ flex: `${s.count} 1 0%`, background: PAYMENT_STATUS_COLORS[s.key] }} />
            ))}
          </div>
          <ul aria-hidden="true" className="m-0 grid list-none grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-2 p-0">
            {segments.map((s) => (
              <li key={s.key} className="flex items-center gap-2 text-[13px] font-semibold">
                <span className="size-2.5 shrink-0 rounded-sm forced-color-adjust-none" style={{ background: PAYMENT_STATUS_COLORS[s.key] }} />
                <span className="flex-1">{s.label}</span>
                <strong className="tabular-nums">{s.count.toLocaleString("en-IN")}</strong>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="m-0 text-[13px] text-ink-2">{OVERVIEW_COPY.noOrders}</p>
      )}
      <p className="m-0 flex items-center gap-2 rounded-10 bg-bg px-3 py-2.5 text-[12.5px] font-semibold text-ink-2">
        <Icon name="webhook" size={17} className="text-sage-fg" />
        {webhookLine(data.webhooks)}
      </p>
    </DashboardPanel>
  );
}

const TH = "px-2 py-[9px] text-right text-[11px] font-extrabold uppercase tracking-[0.06em] text-ink-2";

/** Paid orders, active licenses today and revenue per product in the range, highest revenue first. */
export function ProductPerformancePanel({ data }: { data: OverviewData }) {
  const max = Math.max(0, ...data.products.map((p) => p.revenuePaise));
  return (
    <DashboardPanel id="ov-products" title={OVERVIEW_COPY.products}>
      {data.products.length === 0 ? (
        <p className="m-0 p-4 text-[13px] text-ink-2">{OVERVIEW_COPY.noProducts}</p>
      ) : (
        // Scrolls inside the panel when the columns do not fit (narrow phones, larger text spacing).
        <ScrollRegion labelledBy="ov-products">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th scope="col" className={cn(TH, "pl-4 text-left")}>Product</th>
                <th scope="col" className={TH}>Orders</th>
                <th scope="col" className={TH}>
                  <abbr title="Active licenses" className="no-underline">Active lic.</abbr>
                </th>
                <th scope="col" className={cn(TH, "pr-4")}>Revenue</th>
              </tr>
            </thead>
            <tbody>
              {data.products.map((p) => (
                <tr key={p.id} className="border-t border-line-subtle">
                  <th scope="row" className="px-4 py-2.5 text-left font-bold">
                    {p.name}
                    <div aria-hidden="true" className={cn("mt-[5px] h-[5px]", TRACK)}>
                      <div className="h-full rounded-pill" style={{ width: `${barPercent(p.revenuePaise, max, 3)}%`, background: toneBar(p.tone) }} />
                    </div>
                  </th>
                  <td className="px-2 py-2.5 text-right font-semibold tabular-nums">{p.orders.toLocaleString("en-IN")}</td>
                  <td className="px-2 py-2.5 text-right font-semibold tabular-nums">{p.activeLicenses.toLocaleString("en-IN")}</td>
                  <td className="py-2.5 pl-2 pr-4 text-right font-extrabold tabular-nums">{rupeesWhole(p.revenuePaise)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </DashboardPanel>
  );
}

/** Licenses filtered by a derived status in the Licenses module. */
export function licensesHref(status: string): string {
  return `/admin/licenses?${new URLSearchParams({ "filter[status]": status }).toString()}`;
}

/** Derived license statuses today, each row a link into Licenses filtered by that status. */
export function LicenseHealthPanel({ data, links }: { data: OverviewData; links: OverviewLinks }) {
  const max = Math.max(1, ...data.licenseHealth.map((r) => r.count));
  return (
    <DashboardPanel
      id="ov-licenses"
      title={OVERVIEW_COPY.licenseHealth}
      aside={<PanelLink href="/admin/renewals" show={links.renewals}>{OVERVIEW_COPY.renewalsLink}</PanelLink>}
    >
      <ul className="m-0 grid list-none gap-2.5 px-4 py-3.5">
        {data.licenseHealth.map((row) => {
          const content = (
            <>
              <span>{row.label}</span>
              <span aria-hidden="true" className={cn("h-2.5", TRACK)}>
                <span className="block h-full" style={{ width: `${(row.count / max) * 100}%`, background: LICENSE_HEALTH_COLORS[row.key] }} />
              </span>
              <span className="text-right tabular-nums">
                {row.count.toLocaleString("en-IN")}
                <span className="sr-only"> {row.count === 1 ? "license" : "licenses"}</span>
              </span>
            </>
          );
          const grid = "grid grid-cols-[minmax(0,130px)_1fr_44px] items-center gap-2.5 text-[13px] font-bold text-ink";
          return (
            <li key={row.key}>
              {links.licenses ? (
                <Link href={licensesHref(row.key)} className={cn(grid, "rounded-6 no-underline hover:text-ink [&:hover>span:first-child]:underline")}>
                  {content}
                </Link>
              ) : (
                <div className={grid}>{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </DashboardPanel>
  );
}

/** Open tickets today: three tiles, then per-assignee bars (active Support and Admin staff, then Unassigned). */
export function SupportWorkloadPanel({ data, links }: { data: OverviewData; links: OverviewLinks }) {
  const s = data.support;
  const tiles = [
    { label: "Waiting on us", n: s.waitingOnUs, tone: "blue" as const },
    { label: "Waiting on customer", n: s.waitingOnCustomer, tone: "peach" as const },
    { label: "High priority", n: s.highPriority, tone: "pink" as const },
  ];
  const max = Math.max(1, ...s.assignees.map((a) => a.count));
  return (
    <DashboardPanel
      id="ov-support"
      title={OVERVIEW_COPY.support}
      aside={<PanelLink href="/admin/tickets" show={links.tickets}>{OVERVIEW_COPY.ticketsLink}</PanelLink>}
      bodyClassName="grid gap-3.5 px-4 py-3.5"
    >
      <dl className="m-0 grid grid-cols-3 gap-2">
        {tiles.map((t) => (
          <div key={t.label} className={cn("flex flex-col-reverse justify-end rounded-10 p-2.5", TONE_BG[t.tone])}>
            <dt className="text-[12px] font-bold leading-[normal] text-ink-soft">{t.label}</dt>
            <dd className={cn("m-0 text-[20px] font-extrabold leading-[normal] tabular-nums", TONE_FG[t.tone])}>{t.n.toLocaleString("en-IN")}</dd>
          </div>
        ))}
      </dl>
      <ul aria-label="Open tickets per assignee" className="m-0 grid list-none gap-2 p-0">
        {s.assignees.map((a) => (
          <li key={a.id ?? "unassigned"} className="flex items-center gap-2.5 text-[13px] font-semibold">
            <span className="w-[110px] shrink-0 truncate">{a.name}</span>
            <span aria-hidden="true" className={cn("h-2 flex-1", TRACK)}>
              <span className="block h-full bg-primary" style={{ width: `${(a.count / max) * 100}%` }} />
            </span>
            <strong className="w-6 shrink-0 text-right tabular-nums">
              {a.count.toLocaleString("en-IN")}
              <span className="sr-only"> open</span>
            </strong>
          </li>
        ))}
      </ul>
    </DashboardPanel>
  );
}

/** Latest audit rows (only rendered for roles with `audit.view`). */
export function RecentActivityPanel({ rows, links }: { rows: NonNullable<OverviewData["recentActivity"]>; links: OverviewLinks }) {
  return (
    <DashboardPanel
      id="ov-activity"
      title={OVERVIEW_COPY.activity}
      aside={<PanelLink href="/admin/audit" show={links.audit}>{OVERVIEW_COPY.auditLink}</PanelLink>}
    >
      {rows.length === 0 ? (
        <p className="m-0 p-4 text-[13px] text-ink-2">{OVERVIEW_COPY.noActivity}</p>
      ) : (
        <ol className="m-0 list-none px-4 pb-2.5 pt-1">
          {rows.map((a) => (
            <li key={a.id} className="flex gap-2.5 border-b border-line-subtle py-2 text-[13px]">
              <span className="min-w-0 flex-1 break-words">
                <strong>{a.actor}</strong> <span className="text-ink-soft">{a.action}</span> <span className="text-ink-2">· {a.target}</span>
              </span>
              <time dateTime={a.at} title={formatDateTimeIST(new Date(a.at))} className="whitespace-nowrap text-[12px] font-semibold text-ink-3">
                {a.when}
              </time>
            </li>
          ))}
        </ol>
      )}
    </DashboardPanel>
  );
}
