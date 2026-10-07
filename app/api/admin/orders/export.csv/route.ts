/**
 * GET /api/admin/orders/export.csv?<list filters>[&ids=AX-1,AX-2] (reports.export: Owner, Finance): the accountant
 * CSV of the filtered orders (or the selected ones), at most 10,000 rows, audited "Exported report".
 */
import { csvExportResponse } from "@/lib/admin/export";
import { adminRoute } from "@/lib/admin/http";
import { exportAdminOrders, exportAuditDetail, ORDER_EXPORT_COLUMNS, orderQueryFromRequest } from "@/lib/admin/orders/list";
import { ORDERS_COPY } from "@/lib/admin/orders/model";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("reports.export", async ({ req, staff, actor }) => {
  const query = orderQueryFromRequest(req);
  const rows = await exportAdminOrders(db, query);
  const selected = query.filters.ids !== undefined;
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: selected ? ORDERS_COPY.selectedCsvFileName : ORDERS_COPY.csvFileName,
    rows,
    columns: ORDER_EXPORT_COLUMNS,
    auditTarget: selected ? "Orders (selected)" : "Orders",
    auditDetail: exportAuditDetail(query),
  });
});
