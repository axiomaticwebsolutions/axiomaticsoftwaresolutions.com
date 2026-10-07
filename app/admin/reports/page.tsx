import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AdminModulePage } from "@/components/admin/module-page";
import { ReportsView } from "@/components/admin/reports/reports-view";
import { parseRange, type RangeKey } from "@/lib/admin/overview/range";
import { getAdminReports } from "@/lib/admin/reports/service";
import { db } from "@/lib/db";

export const metadata = adminPageMetadata("reports");

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Runs only for roles that can open Reports (AdminModulePage renders no children for the others). */
async function ReportsContent({ range }: { range: RangeKey }) {
  return <ReportsView data={await getAdminReports(db, { range, now: new Date() })} />;
}

/** /admin/reports: Reports & exports (`reports.view`); `?range=7d|30d|90d|12m` (default 30 days, IST). */
export default async function AdminReportsPage({ searchParams }: PageProps) {
  const range = parseRange((await searchParams).range);
  return (
    <AdminModulePage moduleKey="reports">
      <ReportsContent range={range} />
    </AdminModulePage>
  );
}
