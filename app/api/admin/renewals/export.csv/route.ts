/** GET /api/admin/renewals/export.csv?<list query>: the filtered renewals as CSV (reports.export; audited). */
import { ADMIN_EXPORT_MAX_ROWS, csvExportResponse } from "@/lib/admin/export";
import { datedCsvName, filterSummary, listQueryFromParsed } from "@/lib/admin/licenses/list-state";
import { RENEWAL_CSV_COLUMNS } from "@/lib/admin/renewals/export";
import { RENEWAL_LIST_SPEC, type RenewalFilter, type RenewalSort } from "@/lib/admin/renewals/model";
import { exportAdminRenewals } from "@/lib/admin/renewals/queries";
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";
import { db } from "@/lib/db";

export const GET = adminRoute("reports.export", async ({ req, staff, actor }) => {
  const now = new Date();
  const query = listQueryFromParsed<RenewalFilter, RenewalSort>(parseListQuery(req, RENEWAL_LIST_SPEC));
  const rows = await exportAdminRenewals(db, query, now, ADMIN_EXPORT_MAX_ROWS + 1);
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: datedCsvName("renewals", now),
    rows,
    columns: RENEWAL_CSV_COLUMNS,
    auditTarget: "Renewals",
    auditDetail: filterSummary(query),
  });
});
