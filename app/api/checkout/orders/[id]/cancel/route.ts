/**
 * POST /api/checkout/orders/:id/cancel: the buyer closed the provider checkout without paying.
 * Body { t? } or no body. Access as for the payment return (401 / 403 / 404). AWAITING_PAYMENT -> CANCELED (the open
 * attempt too); any other status is returned unchanged. 200 { status }. 30 requests / 10 min per IP. CSRF applies.
 */
import { getCurrentAuth } from "@/lib/auth/guards";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { cancelOrderPayment } from "@/lib/checkout/cancel";
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
  enforce(await hit(db, RATE_LIMITS.orderActionIp(clientIp(req))));
  const access = await resolveOrderAccessFor(id, { token: orderTokenFrom(req, body.t), auth });
  return json(await cancelOrderPayment(db, access));
});
