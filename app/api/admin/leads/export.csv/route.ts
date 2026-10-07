/**
 * GET /api/admin/leads/export.csv (leads.view + reports.export, so Finance, whose Leads module is locked, cannot) with the list's q / filter[kind] / filter[status] / sort: up to
 * 10,000 requests as CSV (X-Truncated beyond); audited "Exported report".
 */
import { istDateOf } from "@/lib/admin/coupons/model";
import { csvExportResponse } from "@/lib/admin/export";
import { adminRoute } from "@/lib/admin/http";
import { LEAD_LIST_SPEC } from "@/lib/admin/leads/model";
import { LEAD_CSV_COLUMNS, leadExportRows } from "@/lib/admin/leads/service";
import { parseListQuery } from "@/lib/admin/list-query";

export const GET = adminRoute("leads.view", async ({ req, staff, actor }) => {
  const query = parseListQuery(req, LEAD_LIST_SPEC);
  const filters = [query.filters.kind && `type: ${query.filters.kind}`, query.filters.status && `status: ${query.filters.status}`].filter(Boolean);
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: `leads-${istDateOf(new Date())}.csv`,
    rows: await leadExportRows(query),
    columns: LEAD_CSV_COLUMNS,
    auditTarget: "Contact & demo requests",
    auditDetail: filters.length > 0 ? filters.join(" \u00b7 ") : null,
  });
});
