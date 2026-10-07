/**
 * Transactional outbox for business emails (order confirmation, payment failed, license issued, leads, reminders).
 *
 * - enqueueEmail(tx, ...) renders the email now and inserts an OutboxEmail row (PENDING) inside the caller's
 *   transaction, so the email exists exactly when the business change commits. `dedupeKey` is unique and duplicates
 *   are ignored (INSERT ... ON CONFLICT DO NOTHING; no error, so the caller's transaction is never aborted).
 *   Auth and invitation emails (codes, reset and invitation links) are refused: they are sent directly, never stored.
 * - dispatchPendingEmails() claims due rows with one atomic statement (a MATERIALIZED CTE selecting them FOR UPDATE SKIP
 *   LOCKED, then UPDATE ... RETURNING), so concurrent dispatchers never get the same row. A claim sets SENDING, counts the attempt and leases
 *   the row for OUTBOX_LEASE_MS (a dispatcher that dies mid-send leaves the row to be retried after the lease).
 *   Success -> SENT; failure -> PENDING with exponential backoff, or FAILED after OUTBOX_MAX_ATTEMPTS attempts.
 *   Logs carry ids, template ids, attempt counts and error codes only, never addresses, subjects or bodies.
 * - kickEmailDispatch() runs a dispatch on the next tick after the caller commits (concurrent kicks coalesce into one
 *   run plus at most one follow-up). /api/cron/emails is the safety net. Under Vitest kicks are off unless enabled.
 */
import "server-only";
import { db, type Tx } from "@/lib/db";
import { isProduction } from "@/lib/env";
import { log, redact } from "@/lib/log";
import { composeEmail, EmailTemplateError, normalizeRecipient, type ComposedEmail } from "./compose";
import { isDirectEmailTemplateId } from "./defaults";
import {
  getEmailTransport,
  mailboxHint,
  maskEmail,
  sendErrorSummary,
  type EmailSendResult,
  type EmailTransport,
} from "./transport";

export const OUTBOX_MAX_ATTEMPTS = 5;
export const OUTBOX_BASE_DELAY_MS = 60_000;
export const OUTBOX_MAX_DELAY_MS = 60 * 60_000;
/** How long a claimed row stays reserved for its dispatcher. Far above the SMTP timeouts. */
export const OUTBOX_LEASE_MS = 10 * 60_000;
export const DISPATCH_DEFAULT_LIMIT = 50;
const DISPATCH_MAX_LIMIT = 500;
const LAST_ERROR_MAX = 300;

export type EnqueueEmailInput = {
  to: string;
  templateId: string;
  vars: Record<string, string>;
  /** Unique per logical email, e.g. "order_confirmation:AX-10312"; a second enqueue with the same key is ignored. */
  dedupeKey?: string;
  /** Earliest send time (default: now). */
  sendAfter?: Date;
};

/** Delay before retrying after the `attempts`-th failed attempt: 1, 2, 4, 8 ... minutes, capped at an hour. */
export function outboxBackoffMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(OUTBOX_BASE_DELAY_MS * 2 ** (n - 1), OUTBOX_MAX_DELAY_MS);
}

/** Contract violations throw in development and tests (bugs surface early) and are logged in production. */
function reject(error: EmailTemplateError): void {
  if (!isProduction()) throw error;
  log.error("email_enqueue_rejected", { reason: error.reason, template: error.templateId });
}

/** Renders the email and inserts a PENDING outbox row in the caller's transaction (see the module comment). */
export async function enqueueEmail(tx: Tx, input: EnqueueEmailInput): Promise<void> {
  const { templateId } = input;
  if (isDirectEmailTemplateId(templateId)) {
    return reject(new EmailTemplateError("auth_template", templateId, `"${templateId}" is sent with sendAuthEmail(), never stored.`));
  }
  const to = normalizeRecipient(input.to);
  if (!to) return reject(new EmailTemplateError("invalid_recipient", templateId, "The recipient is not a single email address."));

  let composed: ComposedEmail;
  try {
    composed = await composeEmail(tx, templateId, input.vars);
  } catch (error) {
    if (error instanceof EmailTemplateError) return reject(error);
    throw error;
  }
  if (composed.missingVars.length > 0) {
    const error = new EmailTemplateError("missing_vars", templateId, `Missing variables: ${composed.missingVars.join(", ")}.`);
    if (!isProduction()) throw error;
    // Production: still send (the email is informative without the missing part) and make the problem visible.
    log.error("email_missing_vars", { template: templateId, names: composed.missingVars });
  }

  const now = new Date();
  await tx.outboxEmail.createMany({
    data: [
      {
        templateId,
        to,
        subject: composed.subject,
        html: composed.html,
        text: composed.text,
        dedupeKey: input.dedupeKey ?? null,
        sendAfter: input.sendAfter ?? now,
        createdAt: now,
      },
    ],
    skipDuplicates: true,
  });
}

type ClaimedEmail = {
  id: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  templateId: string;
  attempts: number;
};

/**
 * Atomically claims up to `limit` due rows: PENDING rows whose sendAfter has passed, and SENDING rows whose lease
 * expired (their dispatcher died). Rows locked by another dispatcher are skipped, and a row claimed by another
 * dispatcher in the meantime fails the re-check (its lease is in the future), so no row is ever handed out twice.
 * The rows are picked in a MATERIALIZED CTE, which runs once: as an `IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)`
 * subquery, a nested-loop plan re-runs it per row and claims every due row instead of `limit` (lib/jobs/tasks.ts).
 */
export async function claimDueEmails(limit: number, now: Date): Promise<ClaimedEmail[]> {
  const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_MS);
  const rows = await db.$queryRaw<ClaimedEmail[]>`
    WITH picked AS MATERIALIZED (
      SELECT "id" FROM "OutboxEmail"
      WHERE "status" IN ('PENDING'::"EmailStatus", 'SENDING'::"EmailStatus")
        AND "sendAfter" <= ${now}::timestamp(3)
        AND "attempts" < ${OUTBOX_MAX_ATTEMPTS}::int
      ORDER BY "sendAfter", "createdAt"
      LIMIT ${limit}::int
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "OutboxEmail" AS o
    SET "status" = 'SENDING'::"EmailStatus", "attempts" = o."attempts" + 1, "sendAfter" = ${leaseUntil}::timestamp(3)
    FROM picked
    WHERE o."id" = picked."id"
    RETURNING o."id", o."to", o."subject", o."html", o."text", o."templateId", o."attempts"`;
  return rows.map((r) => ({ ...r, attempts: Number(r.attempts) }));
}

/** Rows whose last attempt was interrupted (lease expired) and that have no attempts left become FAILED. */
async function failExhaustedLeases(now: Date): Promise<number> {
  const { count } = await db.outboxEmail.updateMany({
    where: { status: "SENDING", sendAfter: { lte: now }, attempts: { gte: OUTBOX_MAX_ATTEMPTS } },
    data: { status: "FAILED", lastError: "Delivery was interrupted and no attempts are left." },
  });
  return count;
}

function lastErrorText(error: unknown): string {
  const summary = sendErrorSummary(error);
  const message = error instanceof Error ? String(redact(error.message)) : "";
  const parts = [summary.name, summary.errorCode, summary.smtpStatus].filter((p) => p !== undefined && p !== "");
  const text = `${parts.join(" ")}${message ? `: ${message}` : ""}`;
  return text.length > LAST_ERROR_MAX ? `${text.slice(0, LAST_ERROR_MAX - 1)}…` : text;
}

export type DispatchOptions = {
  /** Most rows to claim in this run (default 50, at most 500). */
  limit?: number;
  /** Clock for due checks, leases and backoff (tests). */
  now?: Date;
  /** Transport override (tests); default getEmailTransport(). */
  transport?: EmailTransport;
};

/** Sends due outbox emails once. Returns how many were sent and how many attempts failed. */
export async function dispatchPendingEmails(opts: DispatchOptions = {}): Promise<{ sent: number; failed: number }> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DISPATCH_DEFAULT_LIMIT)), DISPATCH_MAX_LIMIT);
  const clock = () => opts.now ?? new Date();

  const exhausted = await failExhaustedLeases(clock());
  if (exhausted > 0) log.warn("email_outbox_lease_exhausted", { count: exhausted });

  const claimed = await claimDueEmails(limit, clock());
  if (claimed.length === 0) return { sent: 0, failed: 0 };

  const transport = opts.transport ?? (await getEmailTransport());
  let sent = 0;
  let failed = 0;
  for (const row of claimed) {
    let result: EmailSendResult;
    try {
      result = await transport.send({
        to: row.to,
        subject: row.subject,
        html: row.html,
        text: row.text,
        templateId: row.templateId,
      });
    } catch (error) {
      failed += 1;
      const final = row.attempts >= OUTBOX_MAX_ATTEMPTS;
      const lastError = lastErrorText(error);
      await db.outboxEmail
        .updateMany({
          where: { id: row.id, status: "SENDING" },
          data: final
            ? { status: "FAILED", lastError }
            : { status: "PENDING", sendAfter: new Date(clock().getTime() + outboxBackoffMs(row.attempts)), lastError },
        })
        .catch((updateError: unknown) => {
          // The lease still expires, so the row is retried later.
          log.error("email_outbox_update_failed", { outboxId: row.id, error: sendErrorSummary(updateError) });
        });
      log.warn(final ? "email_failed" : "email_retry_scheduled", {
        outboxId: row.id,
        template: row.templateId,
        transport: transport.name,
        attempt: row.attempts,
        error: sendErrorSummary(error),
      });
      continue;
    }
    sent += 1;
    await db.outboxEmail
      .updateMany({ where: { id: row.id, status: "SENDING" }, data: { status: "SENT", sentAt: clock(), lastError: null } })
      .catch((updateError: unknown) => {
        // Sent but not marked: the row is sent again after its lease expires (at-least-once delivery).
        log.error("email_outbox_update_failed", { outboxId: row.id, error: sendErrorSummary(updateError) });
      });
    log.info("email_sent", {
      outboxId: row.id,
      template: row.templateId,
      transport: transport.name,
      to: maskEmail(row.to),
      messageId: result.messageId,
      attempt: row.attempts,
      ...mailboxHint(transport),
    });
  }
  return { sent, failed };
}

// ---------- After-commit dispatch ----------

const KICK_BATCH = 25;
const KICK_MAX_ROUNDS = 8;

type KickState = {
  scheduled: boolean;
  running: Promise<void> | null;
  /** Another kick arrived while a run was in progress: run once more afterwards. */
  again: boolean;
  /** null = default (on, except under Vitest). */
  auto: boolean | null;
};

// On globalThis so every route bundle of one server process shares one dispatcher.
const kickHolder = globalThis as unknown as { __axsEmailKick?: KickState };
function kickState(): KickState {
  kickHolder.__axsEmailKick ??= { scheduled: false, running: null, again: false, auto: null };
  return kickHolder.__axsEmailKick;
}

function autoDispatchEnabled(state: KickState): boolean {
  return state.auto ?? process.env.NODE_ENV !== "test";
}

/** Turns after-commit dispatch on or off (tests). null restores the default (off under Vitest, on elsewhere). */
export function setEmailAutoDispatch(enabled: boolean | null): void {
  kickState().auto = enabled;
}

async function runKick(state: KickState): Promise<void> {
  for (let round = 0; round < KICK_MAX_ROUNDS; round += 1) {
    state.again = false;
    let claimed: number;
    try {
      const { sent, failed } = await dispatchPendingEmails({ limit: KICK_BATCH });
      claimed = sent + failed;
    } catch (error) {
      log.error("email_dispatch_failed", { error: sendErrorSummary(error) });
      return;
    }
    // Stop when nothing new arrived and the batch was not full; the cron job picks up anything left.
    if (!state.again && claimed < KICK_BATCH) return;
  }
}

/**
 * Schedules a dispatch on the next tick (call after the transaction that enqueued emails commits). Never throws and
 * never blocks the caller. Kicks during a scheduled or running dispatch coalesce.
 */
export function kickEmailDispatch(): void {
  const state = kickState();
  if (!autoDispatchEnabled(state)) return;
  if (state.running) {
    state.again = true;
    return;
  }
  if (state.scheduled) return;
  state.scheduled = true;
  setTimeout(() => {
    state.scheduled = false;
    state.running = runKick(state).finally(() => {
      state.running = null;
      // A kick that landed after the last round decided to stop.
      if (state.again) {
        state.again = false;
        kickEmailDispatch();
      }
    });
  }, 0);
}

/** Resolves once no kicked dispatch is scheduled or running (tests). */
export async function waitForEmailDispatch(): Promise<void> {
  const state = kickState();
  for (let i = 0; i < 1000; i += 1) {
    if (state.running) await state.running;
    else if (state.scheduled) await new Promise((resolve) => setTimeout(resolve, 1));
    else return;
  }
}
