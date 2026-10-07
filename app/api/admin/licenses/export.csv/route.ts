/** GET /api/admin/licenses/export.csv?<list query>: the filtered licenses as CSV (reports.export; audited). Keys masked. */
import { csvExportResponse, ADMIN_EXPORT_MAX_ROWS } from "@/lib/admin/export";
import { LICENSE_CSV_COLUMNS } from "@/lib/admin/licenses/export";
import { datedCsvName, filterSummary, listQueryFromParsed } from "@/lib/admin/licenses/list-state";
import { LICENSE_LIST_SPEC, type LicenseFilter, type LicenseSort } from "@/lib/admin/licenses/model";
import { exportAdminLicenses } from "@/lib/admin/licenses/queries";
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";
import { db } from "@/lib/db";

export const GET = adminRoute("reports.export", async ({ req, staff, actor }) => {
  const now = new Date();
  const query = listQueryFromParsed<LicenseFilter, LicenseSort>(parseListQuery(req, LICENSE_LIST_SPEC));
  const rows = await exportAdminLicenses(db, query, now, ADMIN_EXPORT_MAX_ROWS + 1);
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: datedCsvName("licenses", now),
    rows,
    columns: LICENSE_CSV_COLUMNS,
    auditTarget: "Licenses",
    auditDetail: filterSummary(query),
  });
});
