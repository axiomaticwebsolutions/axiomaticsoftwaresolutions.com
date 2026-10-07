/**
 * The maintenance tasks, one batch at a time (lib/jobs/maintenance.ts loops them through lib/jobs/batch.ts). Every
 * batch function changes at most `limit` rows and returns how many it handled. Each task is:
 * - idempotent: it selects only rows that still need the change, so a second run finds nothing to do;
 * - safe to run concurrently: rows are picked with FOR UPDATE SKIP LOCKED, so overlapping runs (a slow run and the
 *   next one, or a manual run) split the work instead of repeating it, and the outer statement re-checks the
 *   condition, so a row the app changed in the meantime (a reopened ticket, a refreshed bucket) is left alone;
 * - bounded: one short statement per batch (uploads: one transaction per batch), never a whole-table statement. The
 *   rows are picked in a MATERIALIZED CTE, never in an `IN (SELECT ... LIMIT n FOR UPDATE SKIP LOCKED)` subquery:
 *   under a nested-loop semi join Postgres re-runs such a subquery for every outer row, its row locks skip the rows
 *   this statement already changed, and the statement ends up changing every matching row instead of n (seen in
 *   tests/db/jobs-maintenance-purges.test.ts). A CTE runs once.
 * Business records (orders, licenses, invoices, tickets and their messages, attached files) are never deleted: tickets
 * only change status, outbox rows keep everything but their content, and only the upload rows nobody attached and the
 * housekeeping rows in PURGES are deleted, each past its retention in lib/jobs/retention.ts.
 * Server-only.
 */
import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { Prisma, type Db } from "@/lib/db";
import { log } from "@/lib/log";
import { StorageError, type StorageDriver } from "@/lib/storage";
import { RETENTION, type MaintenanceCutoffs } from "./retention";

// ---------- Tickets ----------

/**
 * RESOLVED tickets resolved at least 14 days ago become CLOSED, with `closedAt = resolvedAt + 14 days` (the moment the
 * portal and the console started showing them as closed, so the stored value matches what people saw, however late
 * the job ran). `updatedAt` is left alone (nothing visible changed, so the ticket must not jump to the top of the
 * "recently updated" lists) and nobody is emailed. RESOLVED tickets without `resolvedAt` (none are written by the app)
 * stay RESOLVED, like their derived status.
 */
export async function closeResolvedTicketsBatch(client: Db, cutoffs: MaintenanceCutoffs, limit: number): Promise<number> {
  const resolvedBy = cutoffs.ticketsResolvedAtOrBefore;
  return client.$executeRaw`
    WITH picked AS MATERIALIZED (
      SELECT "id" FROM "SupportTicket"
      WHERE "status" = 'RESOLVED'::"TicketStatus" AND "resolvedAt" <= ${resolvedBy}::timestamp(3)
      LIMIT ${limit}::int
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "SupportTicket" AS t
    SET "status" = 'CLOSED'::"TicketStatus",
        "closedAt" = t."resolvedAt" + make_interval(days => ${RETENTION.ticketCloseDays}::int)
    FROM picked
    WHERE t."id" = picked."id"
      AND t."status" = 'RESOLVED'::"TicketStatus"
      AND t."resolvedAt" <= ${resolvedBy}::timestamp(3)`;
}

// ---------- Uploads ----------

/** One storage delete may take this long before it counts as failed (the row is kept and retried next run). */
export const STORAGE_DELETE_TIMEOUT_MS = 20_000;
/** Upper bound for one upload batch transaction (its rows stay locked while their files are deleted). */
export const UPLOAD_BATCH_TX_TIMEOUT_MS = 120_000;

class StorageDeleteTimeoutError extends Error {
  constructor() {
    super("Storage delete timed out");
    this.name = "StorageDeleteTimeoutError";
  }
}

/**
 * The object is not there (or can never have been written), so there is nothing to delete. Both drivers already treat
 * a missing object as success; this also covers S3-compatible stores that answer 404 / NoSuchKey, and keys the
 * drivers refuse (no file can exist under them). A missing bucket is NOT treated as missing: that is misconfiguration.
 */
export function isMissingObjectError(error: unknown): boolean {
  if (error instanceof StorageError) return error.code === "invalid_key";
  if (!error || typeof error !== "object") return false;
  const e = error as { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (e.name === "NoSuchBucket") return false;
  return e.name === "NoSuchKey" || e.name === "NotFound" || e.code === "ENOENT" || e.$metadata?.httpStatusCode === 404;
}

/** Name and code of a storage error for the log (never its message: it can carry the object key). */
function storageErrorSummary(error: unknown): Record<string, string | number> {
  if (!(error instanceof Error)) return { name: typeof error };
  const out: Record<string, string | number> = { name: error.name };
  const { code, $metadata } = error as { code?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (typeof code === "string" || typeof code === "number") out.errorCode = code;
  if (typeof $metadata?.httpStatusCode === "number") out.httpStatus = $metadata.httpStatusCode;
  return out;
}

async function deleteStoredObject(driver: StorageDriver, row: { id: string; storageKey: string }): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      driver.delete(row.storageKey),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new StorageDeleteTimeoutError()), STORAGE_DELETE_TIMEOUT_MS);
      }),
    ]);
    return true;
  } catch (error) {
    if (isMissingObjectError(error)) return true;
    log.warn("maintenance_upload_delete_failed", { uploadId: row.id, error: storageErrorSummary(error) });
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type UploadBatchResult = {
  /** Rows selected in this batch. */
  handled: number;
  /** Rows deleted (their file was deleted or was already gone). */
  deleted: number;
  /** Rows kept because their file could not be deleted. */
  failedIds: string[];
};

/**
 * PENDING uploads older than 24 hours (never attached; the portal no longer accepts them): deletes each file, then the
 * rows whose file is gone, in one transaction that keeps the rows locked meanwhile. A request attaching one of them
 * concurrently either locked it first (the row is skipped here and becomes ATTACHED) or finds it gone (409, nothing
 * is attached to a deleted file). A file that cannot be deleted keeps its row for the next run; `skipIds` keeps this
 * run from picking it again. If the transaction fails after files were deleted, the rows stay PENDING with no file
 * behind them and the next run removes them (a missing file counts as deleted).
 */
export async function deleteStaleUploadsBatch(
  client: PrismaClient,
  cutoffs: MaintenanceCutoffs,
  limit: number,
  storage: () => StorageDriver,
  skipIds: ReadonlySet<string> = new Set(),
): Promise<UploadBatchResult> {
  const createdBefore = cutoffs.uploadsCreatedBefore;
  const skip = [...skipIds];
  return client.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; storageKey: string }>>`
        SELECT "id", "storageKey" FROM "Upload"
        WHERE "status" = 'PENDING'::"UploadStatus"
          AND "createdAt" < ${createdBefore}::timestamp(3)
          AND NOT ("id" = ANY(${skip}::text[]))
        LIMIT ${limit}::int
        FOR UPDATE SKIP LOCKED`;
      if (rows.length === 0) return { handled: 0, deleted: 0, failedIds: [] };
      const driver = storage();
      const removed = await Promise.all(rows.map((row) => deleteStoredObject(driver, row)));
      const done = rows.filter((_row, i) => removed[i]).map((row) => row.id);
      const failedIds = rows.filter((_row, i) => !removed[i]).map((row) => row.id);
      const deleted =
        done.length === 0
          ? 0
          : await tx.$executeRaw`
              DELETE FROM "Upload" WHERE "id" = ANY(${done}::text[]) AND "status" = 'PENDING'::"UploadStatus"`;
      return { handled: rows.length, deleted, failedIds };
    },
    { maxWait: 10_000, timeout: UPLOAD_BATCH_TX_TIMEOUT_MS },
  );
}

// ---------- Outbox ----------

/**
 * `maskEmail()` of lib/email/transport.ts in SQL ("priya@shop.in" -> "pr***@shop.in"; no "@" or a leading one ->
 * "***"), applied to the row being updated (alias `o`). Masking an already masked address returns it unchanged.
 */
const MASKED_RECIPIENT_SQL = Prisma.raw(`CASE
      WHEN strpos(reverse(o."to"), '@') IN (0, length(o."to")) THEN '***'
      ELSE left(o."to", LEAST(2, length(o."to") - strpos(reverse(o."to"), '@'))) || '***' || right(o."to", strpos(reverse(o."to"), '@'))
    END`);

/**
 * SENT outbox emails whose `sentAt` is more than 30 days ago lose their content: `html`, `text` and `subject` become ""
 * (bodies hold order links whose tokens last 30 days, names and addresses; subjects can hold names, e.g. lead_new)
 * and `to` is masked like the logs ("pr***@shop.in"). Kept: id, templateId, dedupeKey (renewal reminders and order
 * emails must never be sent twice), status, attempts, lastError (already redacted) and the timestamps. `html = ''`
 * marks a redacted row. PENDING, SENDING and FAILED rows are not touched (SENT rows always carry sentAt).
 */
export async function redactSentEmailsBatch(client: Db, cutoffs: MaintenanceCutoffs, limit: number): Promise<number> {
  const sentBefore = cutoffs.emailsSentBefore;
  return client.$executeRaw`
    WITH picked AS MATERIALIZED (
      SELECT "id" FROM "OutboxEmail"
      WHERE "status" = 'SENT'::"EmailStatus" AND "html" <> '' AND "sentAt" < ${sentBefore}::timestamp(3)
      LIMIT ${limit}::int
      FOR UPDATE SKIP LOCKED
    )
    UPDATE "OutboxEmail" AS o
    SET "html" = '', "text" = '', "subject" = '', "to" = ${MASKED_RECIPIENT_SQL}
    FROM picked
    WHERE o."id" = picked."id"
      AND o."status" = 'SENT'::"EmailStatus"
      AND o."html" <> ''`;
}

// ---------- Purges ----------

export type PurgeTask = "rateLimits" | "sessions" | "authTokens" | "activity" | "webhookDeliveries";

type PurgeSpec = {
  /** Table and primary-key column (constants below, never input). */
  table: string;
  key: string;
  /** Rows to delete, given the run's cutoffs (unqualified columns of `table`). */
  where: (c: MaintenanceCutoffs) => Prisma.Sql;
};

/**
 * Row purges past their retention (lib/jobs/retention.ts). None of these tables is referenced by a foreign key.
 * - RateLimitBucket: windows that ended (`resetAt <= now`); the store resets such a row on its next hit anyway. With
 *   REDIS_URL set the table only holds rows from before Redis (Redis keys expire by themselves).
 * - Session: expired, or revoked, more than 30 days ago (signed-in sessions are never touched).
 * - AuthToken: expired, or used, more than 30 days ago. Open invitations keep their member/staff row; an invitation
 *   whose last link was purged reads "Invite expired" / "No working link", exactly as before, and Resend still works.
 * - AccountActivity: entries older than 24 calendar months (the Owner's activity log keeps two years).
 * - WebhookDelivery: delivery attempts older than 180 days; WebhookEvent (idempotency and replay) is kept.
 */
export const PURGES: Readonly<Record<PurgeTask, PurgeSpec>> = Object.freeze({
  rateLimits: {
    table: "RateLimitBucket",
    key: "key",
    where: (c) => Prisma.sql`"resetAt" <= ${c.rateLimitsResetAtOrBefore}::timestamp(3)`,
  },
  sessions: {
    table: "Session",
    key: "id",
    where: (c) => Prisma.sql`("expiresAt" < ${c.sessionsDeadBefore}::timestamp(3) OR "revokedAt" < ${c.sessionsDeadBefore}::timestamp(3))`,
  },
  authTokens: {
    table: "AuthToken",
    key: "id",
    where: (c) => Prisma.sql`("expiresAt" < ${c.authTokensDeadBefore}::timestamp(3) OR "usedAt" < ${c.authTokensDeadBefore}::timestamp(3))`,
  },
  activity: {
    table: "AccountActivity",
    key: "id",
    where: (c) => Prisma.sql`"createdAt" < ${c.activityCreatedBefore}::timestamp(3)`,
  },
  webhookDeliveries: {
    table: "WebhookDelivery",
    key: "id",
    where: (c) => Prisma.sql`"receivedAt" < ${c.webhookDeliveriesReceivedBefore}::timestamp(3)`,
  },
});

/** Deletes at most `limit` rows of one purge (see PURGES). Returns the number deleted. */
export async function purgeBatch(client: Db, task: PurgeTask, cutoffs: MaintenanceCutoffs, limit: number): Promise<number> {
  const spec = PURGES[task];
  const table = Prisma.raw(`"${spec.table}"`);
  const key = Prisma.raw(`"${spec.key}"`);
  const where = spec.where(cutoffs);
  return client.$executeRaw(Prisma.sql`
    WITH picked AS MATERIALIZED (
      SELECT ${key} FROM ${table}
      WHERE ${where}
      LIMIT ${limit}::int
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM ${table} AS x
    USING picked
    WHERE x.${key} = picked.${key}
      AND ${where}`);
}
