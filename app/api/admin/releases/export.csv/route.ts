/** GET /api/admin/releases/export.csv?<list filters> (reports.export): matching releases as CSV, audited. */
import { filtersDetail, istDate, RELEASE_CSV_COLUMNS, releaseListQuery } from "@/lib/admin/catalog/api";
import { releaseExportRows } from "@/lib/admin/catalog/releases";
import { csvExportResponse } from "@/lib/admin/export";
import { adminRoute } from "@/lib/admin/http";

export const dynamic = "force-dynamic";

export const GET = adminRoute("reports.export", async ({ req, staff, actor }) => {
  const query = releaseListQuery(req);
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: `releases-${istDate(new Date().toISOString())}.csv`,
    rows: await releaseExportRows(query),
    columns: RELEASE_CSV_COLUMNS,
    auditTarget: "Software releases",
    auditDetail: filtersDetail(query),
  });
});
