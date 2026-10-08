/**
 * GET /api/admin/orders?q=&filter[status]=&filter[method]=&filter[product]=&filter[date]=&filter[from]=&filter[to]=
 * &filter[coupon]=&filter[provider]=&sort=-createdAt&page=1&pageSize=25 -> { items, total, page, pageSize }
 * (orders.view: every staff role). Search: order id, invoice number, email, business, GSTIN, payment id.
 *
 * POST /api/admin/orders { requestId, accountId, items, couponCode?, billing, reason } (orders.create: Owner, Finance)
 * -> 201 { orderId, status: "awaiting_payment", totalPaise, paymentUrl, paymentUrlExpiresAt, emailQueued, replayed }:
 * an unpaid order priced exactly like checkout, with no payment attempt; the customer pays from the tokenised order
 * link (also emailed). Licenses are issued only by the verified payment webhook. A repeat of the same requestId by the
 * same staff member answers 200 with the first order (`replayed: true`). 422 reason_required / validation_failed /
 * cart_invalid / zero_total, 404 Customer, 409 duplicate_request, 429 after 30 an hour per staff member.
 */
import { adminRoute } from "@/lib/admin/http";
import { createPaymentLinkOrder } from "@/lib/admin/orders/create";
import { listAdminOrders, orderQueryFromRequest } from "@/lib/admin/orders/list";
import { orderCreateBody } from "@/lib/admin/orders/schemas";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = adminRoute("orders.view", async ({ req }) => json(await listAdminOrders(db, orderQueryFromRequest(req))));

export const POST = adminRoute("orders.create", async ({ staff, actor, body }) => {
  const input = await body(orderCreateBody);
  enforce(await hit(db, RATE_LIMITS.adminOrderCreate(staff.id)));
  const result = await createPaymentLinkOrder(input, { staff, actor });
  return json(result, { status: result.replayed ? 200 : 201 });
});
