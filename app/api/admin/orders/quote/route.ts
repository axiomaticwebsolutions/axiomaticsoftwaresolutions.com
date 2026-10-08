/**
 * POST /api/admin/orders/quote { accountId | orderId, items, couponCode?, billingState? } (orders.create; with
 * `orderId` also orders.edit) -> { quote }: the "New order" / "Edit order" form's live quote, priced by checkout's own
 * priceCart for the account's Owner (lines, totals, GST split, coupon result, line issues). Read only: no audit row.
 * 404 Customer / Order, 422, 429 after 120 in 10 minutes per staff member.
 */
import { adminRoute } from "@/lib/admin/http";
import { quoteAdminOrder } from "@/lib/admin/orders/create";
import { orderQuoteBody } from "@/lib/admin/orders/schemas";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute("orders.create", async ({ staff, body, requirePerm }) => {
  const input = await body(orderQuoteBody);
  if (input.orderId) requirePerm("orders.edit");
  enforce(await hit(db, RATE_LIMITS.adminOrderQuote(staff.id)));
  return json(await quoteAdminOrder(db, input, new Date()));
});
