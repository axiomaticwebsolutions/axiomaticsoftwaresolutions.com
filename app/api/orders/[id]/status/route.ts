/**
 * GET /api/orders/:id/status: the order page's data, polled every 2 s while a payment confirms
 * (lib/orders/status.ts). Access: a member of the order's account with `invoices.view`, the signed-in placer of an
 * account-less order, or the order link token (the page sends it in X-Order-Token so it never sits in a request line
 * Nginx may log; `?t=` still works) (401 signed out without a token, 403 order_link_expired, 404).
 * The purchaser receives each issued license key once (License.keyDeliveredAt); later responses are masked. Keys are
 * never delivered to cross-site requests. Always Cache-Control: no-store. 300 requests / 5 min per IP.
 */
import { sameOriginOk } from "@/lib/auth/csrf";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { orderTokenFrom } from "@/lib/checkout/request";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { clientIp, json, route } from "@/lib/http";
import { resolveOrderAccess } from "@/lib/orders/access";
import { buildOrderStatus } from "@/lib/orders/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (req, { params }) => {
  const { id } = await params;
  enforce(await hit(db, RATE_LIMITS.orderStatusIp(clientIp(req))));
  const access = await resolveOrderAccess(id, { token: orderTokenFrom(req) });
  const dto = await buildOrderStatus(db, access, { allowKeyDelivery: sameOriginOk(req, getEnv().APP_URL) });
  return json(dto, { headers: { "cache-control": "no-store, max-age=0", pragma: "no-cache" } });
});
