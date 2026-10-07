/**
 * GET /api/admin/orders?q=&filter[status]=&filter[method]=&filter[product]=&filter[date]=&filter[from]=&filter[to]=
 * &filter[coupon]=&filter[provider]=&sort=-createdAt&page=1&pageSize=25 -> { items, total, page, pageSize }
 * (orders.view: every staff role). Search: order id, invoice number, email, business, GSTIN, payment id.
 */
import { adminRoute } from "@/lib/admin/http";
import { listAdminOrders, orderQueryFromRequest } from "@/lib/admin/orders/list";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("orders.view", async ({ req }) => json(await listAdminOrders(db, orderQueryFromRequest(req))));
