import { amountsNote, OVERVIEW_COPY, rupeesWhole, type OverviewData } from "@/lib/admin/overview/model";
import { KpiCards, type OverviewLinks } from "./kpi-cards";
import { LicenseHealthPanel, PaymentStatusPanel, ProductPerformancePanel, RecentActivityPanel, SupportWorkloadPanel } from "./overview-panels";
import { DashboardPanel, PanelGrid } from "./panel";
import { RangeScope } from "./range-scope";
import { RevenueChart } from "./revenue-chart";

export type { OverviewLinks };

export type OverviewDashboardProps = {
  data: OverviewData;
  /** Modules the signed-in role can open (cards and panel links into the others are left out). */
  links: OverviewLinks;
};

/**
 * Admin Overview (Admin Console.dc.html `overview()`), rendered on the server for one range: the date range toolbar,
 * five KPI cards, then the panels (revenue, orders by payment status, product performance, license health, support
 * workload and, for roles with the audit log, recent activity).
 */
export function OverviewDashboard({ data, links }: OverviewDashboardProps) {
  return (
    <RangeScope range={data.range} note={amountsNote(data.sample)}>
      <KpiCards data={data} links={links} />
      <PanelGrid>
        <DashboardPanel
          id="ov-revenue"
          title={OVERVIEW_COPY.revenue}
          aside={<span className="text-[12.5px] font-bold text-ink-2">{rupeesWhole(data.revenue.totalPaise)} excl. GST</span>}
        >
          <RevenueChart revenue={data.revenue} range={data.range} />
        </DashboardPanel>
        <PaymentStatusPanel data={data} links={links} />
        <ProductPerformancePanel data={data} />
        <LicenseHealthPanel data={data} links={links} />
        <SupportWorkloadPanel data={data} links={links} />
        {data.recentActivity ? <RecentActivityPanel rows={data.recentActivity} links={links} /> : null}
      </PanelGrid>
    </RangeScope>
  );
}
