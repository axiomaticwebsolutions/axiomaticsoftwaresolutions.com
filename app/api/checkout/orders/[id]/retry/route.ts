/**
 * POST /api/checkout/orders/:id/retry: "Try again" / "Return to payment" (lib/checkout/payment-attempt.ts).
 * Body { t? } or no body. Access as for the payment return (401 / 403 / 404). FAILED or CANCELED -> AWAITING_PAYMENT
 * with a new payment attempt for the same order and amount (an open AWAITING_PAYMENT attempt is reopened, unless its
 * coupon hold lapsed). 201 { orderId, orderToken, statusUrl, checkout }. 409 not_retryable (also while an attempt is
 * AUTHORIZED or CAPTURED) / order_unavailable (something in the order, or its coupon, can no longer be sold),
 * 502 payment_unavailable.
 * Counts against the order-creation limit (20 / hour per IP). CSRF applies.
 */
import { getCurrentAuth } from "@/lib/auth/guards";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { retryPayment } from "@/lib/checkout/payment-attempt";
import { assertCheckoutCsrf, orderTokenFrom, parseOptionalJsonBody } from "@/lib/checkout/request";
import { db } from "@/lib/db";
import { clientIp, json, route } from "@/lib/http";
import { resolveOrderAccessFor } from "@/lib/orders/access";
import { orderActionRequestSchema } from "@/lib/validation/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>(async (req, { params }) => {
  const { id } = await params;
  const auth = await getCurrentAuth();
  assertCheckoutCsrf(req, auth?.session.id);
  const body = await parseOptionalJsonBody(req, orderActionRequestSchema);
  enforce(await hit(db, RATE_LIMITS.orderIp(clientIp(req))));
  const access = await resolveOrderAccessFor(id, { token: orderTokenFrom(req, body.t), auth });
  return json(await retryPayment(db, access), { status: 201 });
});
