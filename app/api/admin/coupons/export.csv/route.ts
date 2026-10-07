/**
 * GET /api/admin/coupons/export.csv (reports.export) with the list's q / filter[status] / sort: every matching coupon
 * as CSV; audited "Exported report".
 */
import { COUPON_LIST_SPEC, filterAndSortCoupons } from "@/lib/admin/coupons/model";
import { COUPON_CSV_COLUMNS, loadCoupons } from "@/lib/admin/coupons/service";
import { csvExportResponse } from "@/lib/admin/export";
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";
import { istDateOf } from "@/lib/admin/coupons/model";

export const GET = adminRoute("reports.export", async ({ req, staff, actor }) => {
  const query = parseListQuery(req, COUPON_LIST_SPEC);
  const now = new Date();
  const { coupons } = await loadCoupons(undefined, now);
  const rows = filterAndSortCoupons(coupons, query);
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: `coupons-${istDateOf(now)}.csv`,
    rows,
    columns: COUPON_CSV_COLUMNS,
    auditTarget: "Coupons",
    auditDetail: query.filters.status ? `status: ${query.filters.status}` : null,
  });
});
