/**
 * POST /api/checkout/orders: places an order and opens a payment attempt (lib/checkout/create-order.ts).
 * Body { items, couponCode?, billing: { name, email, phone, business?, address, city, state, pin, gstin? },
 * createAccount?: { password }, acceptTerms: true } (strict, at most 32 KB).
 * 201 { orderId, orderToken, statusUrl, checkout: { kind: "mock", url } | { kind: "razorpay", ... } }.
 * Errors: 422 validation_failed / cart_invalid (with issues) / zero_total, 403 csrf_failed / forbidden /
 * staff_checkout, 409 email_taken, 429 too_many_attempts (20 orders per hour per IP; account creation also counts
 * against RATE_LIMITS.register), 502 payment_unavailable.
 * With createAccount (signed out only) the new customer is signed in: session cookie plus a CSRF cookie bound to the
 * new session. Never cached.
 */
import { startSessionCookies } from "@/lib/auth/flows/route-helpers";
import { getCurrentAuth } from "@/lib/auth/guards";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { resolveCheckoutBuyer } from "@/lib/checkout/buyer";
import { createCheckoutOrder } from "@/lib/checkout/create-order";
import { assertCheckoutCsrf } from "@/lib/checkout/request";
import { db } from "@/lib/db";
import { clientIp, json, parseJsonBody, route } from "@/lib/http";
import { createOrderRequestSchema } from "@/lib/validation/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;

export const POST = route(async (req) => {
  const auth = await getCurrentAuth();
  assertCheckoutCsrf(req, auth?.session.id);
  const body = await parseJsonBody(req, createOrderRequestSchema, { maxBytes: MAX_BODY_BYTES });
  const ip = clientIp(req);
  enforce(await hit(db, RATE_LIMITS.orderIp(ip)));

  const buyer = await resolveCheckoutBuyer(db, auth);
  const { session, createdUserId: _createdUserId, ...payload } = await createCheckoutOrder(db, body, {
    buyer,
    ip,
    userAgent: req.headers.get("user-agent"),
  });
  if (session) await startSessionCookies(session.token, { id: session.id, expiresAt: session.expiresAt });
  return json(payload, { status: 201 });
});
