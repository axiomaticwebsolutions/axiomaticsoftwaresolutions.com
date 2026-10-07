/**
 * GET /api/account/orders?q=&status=&sort=&page= -> 200 { orders, total, page, pageSize, pageCount }.
 * The active business account's orders (claimed guest checkouts included), 8 per page. q: order id or invoice number;
 * status: all | paid | refunded | pending | failed | canceled; sort: date | status | total with "-" for descending
 * (default -date); page: 1-based, past the end shows the last page. Team permission `invoices.view` (every role),
 * verified email. 401, 403 no_account / email_unverified, 422 validation_failed for bad parameters. no-store.
 */
import { db } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { listAccountOrders } from "@/lib/portal/orders";
import { parseOrderListQuery } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "invoices.view" });
  const query = parseOrderListQuery(req.nextUrl.searchParams);
  return json(await listAccountOrders(db, ctx.account.id, query));
});
