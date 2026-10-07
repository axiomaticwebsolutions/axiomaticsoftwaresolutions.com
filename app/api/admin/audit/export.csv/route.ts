/**
 * GET /api/admin/audit/export.csv?<the list's q, filters and sort> -> text/csv "audit-log-YYYY-MM-DD.csv" (IST), at
 * most 10,000 rows (X-Truncated: 1 beyond), X-Row-Count. Needs audit.view (decisions.md: the audit export is the one
 * export that does not need reports.export); the export itself writes an "Exported report" audit row.
 */
import { AUDIT_CSV_COLUMNS, AUDIT_EXPORT_FILE, AUDIT_LIST_SPEC, auditExportDetail } from "@/lib/admin/audit/model";
import { isoDateIST } from "@/lib/admin/audit/format";
import { exportAudit } from "@/lib/admin/audit/service";
import { ADMIN_EXPORT_MAX_ROWS, csvExportResponse } from "@/lib/admin/export";
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("audit.view", async ({ req, staff, actor }) => {
  const query = parseListQuery(req, AUDIT_LIST_SPEC);
  const rows = await exportAudit(db, query, ADMIN_EXPORT_MAX_ROWS + 1);
  return csvExportResponse({
    staff,
    actor,
    perm: "audit.view",
    fileName: `${AUDIT_EXPORT_FILE}-${isoDateIST(new Date())}`,
    rows,
    columns: AUDIT_CSV_COLUMNS,
    auditTarget: "Audit log",
    auditDetail: auditExportDetail(query),
  });
});
