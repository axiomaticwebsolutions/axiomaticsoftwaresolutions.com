import { AdminAction } from "@/components/admin/admin-action";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AdminModulePage } from "@/components/admin/module-page";
import { OverviewDashboard } from "@/components/admin/overview/overview-dashboard";
import { getAdminContext } from "@/lib/admin/context";
import { DEFAULT_RANGE, parseRange, type RangeKey } from "@/lib/admin/overview/range";
import { getAdminOverview } from "@/lib/admin/overview/service";
import { db } from "@/lib/db";

export const metadata = adminPageMetadata("overview");

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Loads the overview for the signed-in role (recent activity only with `audit.view`). */
async function OverviewContent({ range }: { range: RangeKey }) {
  const ctx = await getAdminContext();
  const data = await getAdminOverview(db, { range, now: new Date(), includeActivity: ctx.can("audit.view") });
  const links = {
    reports: ctx.canView("reports"),
    orders: ctx.canView("orders"),
    licenses: ctx.canView("licenses"),
    renewals: ctx.canView("renewals"),
    tickets: ctx.canView("tickets"),
    audit: ctx.canView("audit"),
  };
  return <OverviewDashboard data={data} links={links} />;
}

/**
 * /admin: Overview (Admin Console.dc.html #overview); `?range=7d|30d|90d|12m` (default 30 days, IST). "Export summary"
 * opens Reports & exports for the same range (prototype: it navigated to Reports), gated by `reports.export`.
 */
export default async function AdminOverviewPage({ searchParams }: PageProps) {
  const range = parseRange((await searchParams).range);
  return (
    <AdminModulePage
      moduleKey="overview"
      actions={
        <AdminAction perm="reports.export" href={range === DEFAULT_RANGE ? "/admin/reports" : `/admin/reports?range=${range}`} icon="download">
          Export summary
        </AdminAction>
      }
    >
      <OverviewContent range={range} />
    </AdminModulePage>
  );
}
