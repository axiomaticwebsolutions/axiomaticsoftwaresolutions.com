/** GET /api/admin/products/export.csv?<list filters> (reports.export): every matching product as CSV, audited. */
import { filtersDetail, istDate, PRODUCT_CSV_COLUMNS, productListQuery } from "@/lib/admin/catalog/api";
import { productRows } from "@/lib/admin/catalog/products";
import { csvExportResponse } from "@/lib/admin/export";
import { adminRoute } from "@/lib/admin/http";

export const dynamic = "force-dynamic";

export const GET = adminRoute("reports.export", async ({ req, staff, actor }) => {
  const query = productListQuery(req);
  return csvExportResponse({
    staff,
    actor,
    perm: "reports.export",
    fileName: `products-${istDate(new Date().toISOString())}.csv`,
    rows: await productRows(query),
    columns: PRODUCT_CSV_COLUMNS,
    auditTarget: "Products",
    auditDetail: filtersDetail(query),
  });
});
