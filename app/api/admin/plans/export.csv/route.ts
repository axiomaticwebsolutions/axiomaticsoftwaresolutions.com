/** GET /api/admin/plans/export.csv?<list filters> (reports.export): matching plans as CSV (prices excl. GST), audited. */
import { filtersDetail, istDate, PLAN_CSV_COLUMNS, planListQuery } from "@/lib/admin/catalog/api";
import { planExportRows } from "@/lib/admin/catalog/plans";
import { csvExportResponse } from "@/lib/admin/export";
import { adminRoute } from "@/lib/admin/http";

export const dynamic = "force-dynamic";

export const GET = adminRoute("reports.export", async ({ req, staff, actor }) => {
  const query = planListQuery(req);
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: `plans-${istDate(new Date().toISOString())}.csv`,
    rows: await planExportRows(query),
    columns: PLAN_CSV_COLUMNS,
    auditTarget: "Plans & pricing",
    auditDetail: filtersDetail(query),
  });
});
