/**
 * POST /api/checkout/quote: re-prices the client cart on the server for display (docs/api-contracts.md section 3).
 * Body { items: [{ planId, qty, kind?, targetLicenseId? }], couponCode?, billingState? } (strict, at most 16 KB).
 * 200 { lines, subtotalPaise, discountPaise, taxablePaise, cgstPaise, sgstPaise, igstPaise, totalPaise, gstRatePct,
 * intraState, companyState, coupon, issues }: invalid lines are dropped and listed in `issues`; prices, coupon values
 * and tax come from the database only. CSRF (session or "anon" binding) and same-origin checks apply.
 * Rate limits per IP: quotes with a coupon code count against RATE_LIMITS.couponIp (20 / 10 min), plain quotes
 * against 120 / 10 min. 429 with Retry-After. Never cached.
 */
import { getCurrentAuth } from "@/lib/auth/guards";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { resolveCheckoutBuyer } from "@/lib/checkout/buyer";
import { priceCart, toQuoteDto } from "@/lib/checkout/quote";
import { assertCheckoutCsrf } from "@/lib/checkout/request";
import { db } from "@/lib/db";
import { clientIp, json, parseJsonBody, route } from "@/lib/http";
import { quoteRequestSchema } from "@/lib/validation/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

export const POST = route(async (req) => {
  const auth = await getCurrentAuth();
  assertCheckoutCsrf(req, auth?.session.id);
  const body = await parseJsonBody(req, quoteRequestSchema, { maxBytes: MAX_BODY_BYTES });
  const ip = clientIp(req);
  enforce(await hit(db, body.couponCode ? RATE_LIMITS.couponIp(ip) : RATE_LIMITS.quoteIp(ip)));
  const buyer = await resolveCheckoutBuyer(db, auth);
  const priced = await priceCart(db, body, buyer, new Date());
  return json(toQuoteDto(priced));
});
