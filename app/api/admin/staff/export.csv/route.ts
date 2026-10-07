/**
 * GET /api/admin/staff/export.csv?<the list's q and filters> -> text/csv "staff-YYYY-MM-DD.csv" (IST date), at most
 * 10,000 rows (X-Truncated: 1 beyond that), X-Row-Count. Opens for the Owner (staff.manage) and needs reports.export,
 * which the Owner holds; the export writes one "Exported report" audit row.
 */
import { csvExportResponse, ADMIN_EXPORT_MAX_ROWS } from "@/lib/admin/export";
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";
import { isoDateIST } from "@/lib/admin/audit/format";
import { STAFF_CSV_COLUMNS, STAFF_EXPORT_FILE, STAFF_LIST_SPEC, staffExportDetail } from "@/lib/admin/staff/model";
import { exportStaff } from "@/lib/admin/staff/service";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("staff.manage", async ({ req, staff, actor }) => {
  const query = parseListQuery(req, STAFF_LIST_SPEC);
  const now = new Date();
  const rows = await exportStaff(db, query, ADMIN_EXPORT_MAX_ROWS + 1, now);
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: `${STAFF_EXPORT_FILE}-${isoDateIST(now)}`,
    rows,
    columns: STAFF_CSV_COLUMNS,
    auditTarget: "Staff",
    auditDetail: staffExportDetail(query),
  });
});
