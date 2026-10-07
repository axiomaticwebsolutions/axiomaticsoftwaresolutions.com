/** GET /api/admin/templates/export.csv (templates.manage + reports.export) with the list's q / filter[status] / sort; audited. */
import { istDateOf } from "@/lib/admin/coupons/model";
import { csvExportResponse } from "@/lib/admin/export";
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";
import { filterAndSortTemplates, TEMPLATE_LIST_SPEC } from "@/lib/admin/templates/model";
import { loadTemplates, TEMPLATE_CSV_COLUMNS } from "@/lib/admin/templates/service";

export const GET = adminRoute("templates.manage", async ({ req, staff, actor }) => {
  const query = parseListQuery(req, TEMPLATE_LIST_SPEC);
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: `templates-${istDateOf(new Date())}.csv`,
    rows: filterAndSortTemplates(await loadTemplates(), query),
    columns: TEMPLATE_CSV_COLUMNS,
    auditTarget: "Notification templates",
    auditDetail: query.filters.status ? `status: ${query.filters.status}` : null,
  });
});
