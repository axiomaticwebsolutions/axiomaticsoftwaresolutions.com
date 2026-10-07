/**
 * POST /api/checkout/orders/:id/return: the browser reports the hosted checkout's result.
 * Body { providerPaymentId, providerSignature, t? } (strict, 4 KB). Access: order link token (`t` in the body or
 * `?t=`), the signed-in placer of an account-less order, or a member with the `purchases` team permission
 * (lib/orders/access.ts; 401 / 403 / 404). The signature is verified against the order's payment attempts in constant
 * time (400 `invalid_signature` otherwise); a valid return marks that attempt AUTHORIZED and moves AWAITING_PAYMENT,
 * PENDING, FAILED or CANCELED -> CONFIRMING (the provider signs only successful payments), returning 200 { status }.
 * It never marks the order paid and never issues licenses (only the verified webhook or reconciliation does).
 * Signature checks are counted before verifying (30 / 10 min per IP; refunded on success). CSRF applies.
 */
import { getCurrentAuth } from "@/lib/auth/guards";
import { enforceAttempts, RATE_LIMITS, refund } from "@/lib/auth/rate-limit";
import { assertCheckoutCsrf, orderTokenFrom } from "@/lib/checkout/request";
import { recordPaymentReturn } from "@/lib/checkout/return";
import { db } from "@/lib/db";
import { clientIp, json, parseJsonBody, route } from "@/lib/http";
import { resolveOrderAccessFor } from "@/lib/orders/access";
import { orderReturnRequestSchema } from "@/lib/validation/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const POST = route<Context>(async (req, { params }) => {
  const { id } = await params;
  const auth = await getCurrentAuth();
  assertCheckoutCsrf(req, auth?.session.id);
  const body = await parseJsonBody(req, orderReturnRequestSchema, { maxBytes: 4096 });
  const rule = RATE_LIMITS.orderReturnIp(clientIp(req));
  await enforceAttempts(db, [rule]);

  const access = await resolveOrderAccessFor(id, { token: orderTokenFrom(req, body.t), auth });
  const result = await recordPaymentReturn(db, access, {
    providerPaymentId: body.providerPaymentId,
    providerSignature: body.providerSignature,
  });
  await refund(db, rule);
  return json(result);
});
