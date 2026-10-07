/**
 * GET /api/admin/reports/export.csv?report=<key>&range=7d|30d|90d|12m -> text/csv download (lib/csv.ts format) with
 * `X-Row-Count` (and `X-Truncated: 1` above 10,000 rows). Keys: sales-register, gst-by-state, refunds,
 * license-register, renewal-forecast, support-sla (the prototype's export cards) and sales-by-month, gst-by-month,
 * sales-by-product, license-health, support-workload (the on-page reports). `reports.export` (Owner, Finance); every
 * export writes one "Exported report" audit row naming the report and its scope. Unknown report -> 422.
 */
import { adminRoute } from "@/lib/admin/http";
import { csvExportResponse } from "@/lib/admin/export";
import { parseRange } from "@/lib/admin/overview/range";
import { buildReportExport } from "@/lib/admin/reports/exports";
import { isReportExportKey, REPORT_EXPORT_KEYS } from "@/lib/admin/reports/model";
import type { CsvColumn, CsvValue } from "@/lib/csv";
import { db } from "@/lib/db";
import { errors } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("reports.export", async ({ req, staff, actor }) => {
  const params = req.nextUrl.searchParams;
  const report = params.get("report");
  if (!isReportExportKey(report)) {
    throw errors.validation({ report: `Choose one of: ${REPORT_EXPORT_KEYS.join(", ")}.` });
  }
  const built = await buildReportExport(db, report, { range: parseRange(params.get("range")), now: new Date() });
  const columns: CsvColumn<CsvValue[]>[] = built.header.map((header, i) => ({ header, value: (row) => row[i] }));
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: built.fileName,
    rows: built.rows,
    columns,
    auditTarget: built.title,
    auditDetail: built.scope,
  });
});
