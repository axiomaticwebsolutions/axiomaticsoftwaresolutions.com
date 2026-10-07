/**
 * GET|POST /api/cron/reconcile: payment reconciliation (lib/payments/reconcile.ts), run by the scheduler every
 * 10 minutes with `Authorization: Bearer <CRON_SECRET>` (lib/auth/cron.ts, constant time). No cookies, so no CSRF
 * token or same-origin check. 401 `unauthorized` without the right secret. 200 with the run summary (ids and counts
 * only), `Cache-Control: no-store`. Not rate limited: the secret has at least 256 bits and a lockout would stop the
 * real scheduler; the job itself is bounded (at most 50 payment attempts and 50 pending refunds per run). The body is the
 * payment summary with the refund summary under `refunds` (refunds still PENDING a day after they were issued).
 */
import { assertCronAuthorized } from "@/lib/auth/cron";
import { json, route } from "@/lib/http";
import { reconcilePendingRefunds, reconcileStuckOrders, RECONCILE_DEFAULT_LIMIT } from "@/lib/payments/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request): Promise<Response> {
  assertCronAuthorized(req);
  const summary = await reconcileStuckOrders({ limit: RECONCILE_DEFAULT_LIMIT });
  const refunds = await reconcilePendingRefunds({ limit: RECONCILE_DEFAULT_LIMIT });
  return json({ ...summary, refunds });
}

export const GET = route(handle);
export const POST = route(handle);
