/**
 * GET|POST /api/cron/maintenance: daily housekeeping (lib/jobs/maintenance.ts runMaintenance): closes tickets RESOLVED
 * for 14 days, deletes PENDING uploads older than 24 hours (file, then row), redacts SENT outbox emails older than
 * 30 days, and purges ended rate-limit buckets, sessions and auth tokens dead for 30 days, account activity older than
 * 24 months and webhook deliveries older than 180 days. Run by the scheduler once a day (deploy/cron-maintenance.sh).
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (lib/auth/cron.ts, constant time); 401 `unauthorized` otherwise (with
 * WWW-Authenticate). No cookies, so no CSRF. Concurrent runs are safe: rows are taken with SKIP LOCKED and every task
 * is idempotent. The run stops starting new batches after 240 s (well inside maxDuration); unfinished tasks continue
 * on the next run.
 * 200 with the counts ({ ticketsClosed, uploadsDeleted, emailsRedacted, rateLimitsPurged, sessionsPurged,
 * verificationsPurged (AuthToken rows), activityPurged, webhookDeliveriesPurged }, plus `more` listing unfinished
 * tasks); 500 with the same body plus `failed` (and `uploadsFailed`) when a task failed, so the scheduler marks the run
 * failed. Counts and task names only; Cache-Control: no-store.
 */
import { assertCronAuthorized } from "@/lib/auth/cron";
import { json, route } from "@/lib/http";
import { runMaintenance } from "@/lib/jobs/maintenance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: Request): Promise<Response> {
  assertCronAuthorized(req);
  const result = await runMaintenance();
  return json(result, { status: result.failed ? 500 : 200 });
}

export const GET = route(handle);
export const POST = route(handle);
