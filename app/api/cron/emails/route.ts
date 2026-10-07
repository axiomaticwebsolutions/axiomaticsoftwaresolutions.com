/**
 * GET|POST /api/cron/emails: sends due outbox emails (lib/email/outbox.ts). Run every minute by the scheduler; the
 * after-commit kick normally sends them first, so this is the safety net (retries, restarts, missed kicks).
 *
 * Auth: `Authorization: Bearer <CRON_SECRET>` (lib/auth/cron.ts, constant time); 401 `unauthorized` otherwise (with
 * WWW-Authenticate). No cookies, so no CSRF. Concurrent runs are safe: rows are claimed with SKIP LOCKED.
 * Works through at most MAX_BATCHES batches of BATCH_SIZE per call to stay well inside request timeouts.
 * 200 { sent, failed } with Cache-Control: no-store.
 */
import type { NextRequest } from "next/server";
import { assertCronAuthorized } from "@/lib/auth/cron";
import { dispatchPendingEmails } from "@/lib/email";
import { json, route } from "@/lib/http";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BATCH_SIZE = 50;
const MAX_BATCHES = 6;

async function handle(req: NextRequest): Promise<Response> {
  assertCronAuthorized(req);
  let sent = 0;
  let failed = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const result = await dispatchPendingEmails({ limit: BATCH_SIZE });
    sent += result.sent;
    failed += result.failed;
    if (result.sent + result.failed < BATCH_SIZE) break;
  }
  if (sent > 0 || failed > 0) log.info("cron_emails", { sent, failed });
  return json({ sent, failed });
}

export const GET = route(handle);
export const POST = route(handle);
