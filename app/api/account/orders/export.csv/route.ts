/**
 * GET /api/account/orders/export.csv?q=&status=&sort= -> 200 text/csv attachment "orders.csv" (UTF-8 with BOM, CRLF):
 * every order matching the filters (no paging, at most 10,000) with Order, Date, Invoice, Status, Taxable, CGST,
 * SGST, IGST, Total (rupees, 2 decimals; IST dates), Invoice date, Place of supply, Billed GSTIN, Seller GSTIN.
 * Team permission `invoices.view`, verified email. 20 exports / 10 min per user (429); 403 for cross-site requests.
 * Header X-Export-Rows: rows written; X-Export-Truncated: "1" when the limit cut the list. no-store.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { csvHeaders } from "@/lib/csv";
import { db } from "@/lib/db";
import { errors, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { isCrossSiteRequest } from "@/lib/portal/export";
import { exportAccountOrdersCsv, ORDERS_CSV_FILE_NAME } from "@/lib/portal/orders";
import { parseOrderListQuery } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "invoices.view" });
  if (isCrossSiteRequest(req.headers)) throw errors.forbidden();
  const query = parseOrderListQuery(req.nextUrl.searchParams);
  enforce(await hit(db, RATE_LIMITS.ordersExport(ctx.user.id)));
  const { csv, rows, truncated } = await exportAccountOrdersCsv(db, ctx.account.id, query);
  return new Response(csv, {
    status: 200,
    headers: { ...csvHeaders(ORDERS_CSV_FILE_NAME), "X-Export-Rows": String(rows), "X-Export-Truncated": truncated ? "1" : "0" },
  });
});
