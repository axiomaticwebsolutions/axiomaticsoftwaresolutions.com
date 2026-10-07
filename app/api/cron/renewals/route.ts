/**
 * GET|POST /api/cron/renewals: the automatic renewal reminders the Renewals page promises (renewal_30 while 23-30 days
 * are left, renewal_7 within the last 7 days; lib/admin/renewals/remind.ts sendScheduledRenewalReminders). Run by the
 * scheduler once a day (any time; reruns never send twice: one email per license, template, term and recipient).
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (lib/auth/cron.ts, constant time); 401 `unauthorized` otherwise. No
 * cookies, so no CSRF. 200 { queued, skipped } (counts only) with Cache-Control: no-store. Each license is its own
 * transaction, so a run cut short by the platform timeout keeps what it queued and the next run continues.
 */
import { sendScheduledRenewalReminders } from "@/lib/admin/renewals/remind";
import { assertCronAuthorized } from "@/lib/auth/cron";
import { json, route } from "@/lib/http";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request): Promise<Response> {
  assertCronAuthorized(req);
  const result = await sendScheduledRenewalReminders();
  if (result.queued > 0) log.info("cron_renewals", result);
  return json(result);
}

export const GET = route(handle);
export const POST = route(handle);
