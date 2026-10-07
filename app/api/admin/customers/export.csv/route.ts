/** GET /api/admin/customers/export.csv?<list query>: the filtered customers as CSV (reports.export; audited). */
import { CUSTOMER_CSV_COLUMNS } from "@/lib/admin/customers/export";
import { CUSTOMER_LIST_SPEC, type CustomerFilter, type CustomerSort } from "@/lib/admin/customers/model";
import { exportAdminCustomers } from "@/lib/admin/customers/queries";
import { ADMIN_EXPORT_MAX_ROWS, csvExportResponse } from "@/lib/admin/export";
import { datedCsvName, filterSummary, listQueryFromParsed } from "@/lib/admin/licenses/list-state";
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";
import { db } from "@/lib/db";

export const GET = adminRoute("reports.export", async ({ req, staff, actor }) => {
  const now = new Date();
  const query = listQueryFromParsed<CustomerFilter, CustomerSort>(parseListQuery(req, CUSTOMER_LIST_SPEC));
  const rows = await exportAdminCustomers(db, query, now, ADMIN_EXPORT_MAX_ROWS + 1);
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: datedCsvName("customers", now),
    rows,
    columns: CUSTOMER_CSV_COLUMNS,
    auditTarget: "Customers",
    auditDetail: filterSummary(query),
  });
});
