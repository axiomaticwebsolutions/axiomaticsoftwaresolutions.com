/** GET /api/admin/faqs/export.csv (content.manage + reports.export) with the list's q / filter[page] / filter[status] / sort; audited. */
import { istDateOf } from "@/lib/admin/coupons/model";
import { FAQ_LIST_SPEC, filterAndSortFaqs } from "@/lib/admin/content/model";
import { FAQ_CSV_COLUMNS, loadFaqs } from "@/lib/admin/content/service";
import { csvExportResponse } from "@/lib/admin/export";
import { adminRoute } from "@/lib/admin/http";
import { parseListQuery } from "@/lib/admin/list-query";

export const GET = adminRoute("content.manage", async ({ req, staff, actor }) => {
  const query = parseListQuery(req, FAQ_LIST_SPEC);
  const { faqs, pages } = await loadFaqs();
  const filters = [query.filters.page && `page: ${query.filters.page}`, query.filters.status && `status: ${query.filters.status}`].filter(Boolean);
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: `faqs-${istDateOf(new Date())}.csv`,
    rows: filterAndSortFaqs(faqs, query, pages),
    columns: FAQ_CSV_COLUMNS,
    auditTarget: "FAQs",
    auditDetail: filters.length > 0 ? filters.join(" \u00b7 ") : null,
  });
});
