/**
 * Daily maintenance (GET|POST /api/cron/maintenance; docs/decisions.md "Phase 7 decisions"), in this order:
 *   tickets            RESOLVED for 14 days -> CLOSED (closedAt = resolvedAt + 14 days; no email)
 *   uploads            PENDING uploads older than 24 h: file deleted, then the row
 *   emails             SENT outbox emails older than 30 days: bodies and subject emptied, recipient masked
 *   rateLimits         RateLimitBucket rows whose window ended
 *   sessions           expired or revoked more than 30 days ago
 *   authTokens         expired or used more than 30 days ago
 *   activity           AccountActivity older than 24 months
 *   webhookDeliveries  WebhookDelivery older than 180 days (WebhookEvent is kept)
 * Rules and boundaries: lib/jobs/retention.ts; statements and concurrency: lib/jobs/tasks.ts. Renewal reminders are
 * not part of this job (they run in /api/cron/renewals).
 *
 * Every task runs in batches (500 rows per statement, 25 uploads per transaction; MAINTENANCE_DEFAULTS) until it is
 * done, reaches its row cap (100,000), or uses up its share of the time budget: each task may use the time left
 * divided by the tasks left, so a large backlog in one task never starves the others, and time a task does not need
 * goes to the next.
 * Unfinished tasks are listed in `more` and continue on the next run. A failing task is logged and listed in
 * `failed`; the other tasks still run. Overlapping runs are safe (SKIP LOCKED): they split the rows.
 */
import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { db as defaultDb } from "@/lib/db";
import { log } from "@/lib/log";
import { getStorage, StorageError, type StorageDriver } from "@/lib/storage";
import { runBatches, type BatchLimits, type BatchOutcome } from "./batch";
import { maintenanceCutoffs, type MaintenanceCutoffs } from "./retention";
import { closeResolvedTicketsBatch, deleteStaleUploadsBatch, purgeBatch, redactSentEmailsBatch } from "./tasks";

export const MAINTENANCE_TASKS = [
  "tickets",
  "uploads",
  "emails",
  "rateLimits",
  "sessions",
  "authTokens",
  "activity",
  "webhookDeliveries",
] as const;
export type MaintenanceTask = (typeof MAINTENANCE_TASKS)[number];

/**
 * The count each task reports, as a flat key of the result (deploy/cron-job.sh treats an object of zero counts as an
 * idle run and logs nothing). No key may match the logger's secret-looking names (lib/log.ts: token, code, key ...),
 * or the summary log line would hide its value: AuthToken rows (sign-in and verification codes, reset, invitation and
 * claim links) are counted as `verificationsPurged`.
 */
export const MAINTENANCE_COUNT_KEYS = {
  tickets: "ticketsClosed",
  uploads: "uploadsDeleted",
  emails: "emailsRedacted",
  rateLimits: "rateLimitsPurged",
  sessions: "sessionsPurged",
  authTokens: "verificationsPurged",
  activity: "activityPurged",
  webhookDeliveries: "webhookDeliveriesPurged",
} as const satisfies Record<MaintenanceTask, string>;

export type MaintenanceCountKey = (typeof MAINTENANCE_COUNT_KEYS)[MaintenanceTask];
export type MaintenanceCounts = Record<MaintenanceCountKey, number>;

export type MaintenanceResult = MaintenanceCounts & {
  /** Uploads whose file could not be deleted (rows kept, retried next run). Present only when above 0. */
  uploadsFailed?: number;
  /** Tasks that stopped at their row cap or time share and continue next run. Present only when not empty. */
  more?: MaintenanceTask[];
  /** Tasks that failed (see the log line maintenance_task_failed). Present only when not empty. */
  failed?: MaintenanceTask[];
};

export const MAINTENANCE_DEFAULTS = Object.freeze({
  /** Rows per statement for the set-based tasks. */
  batchSize: 500,
  /** Uploads per transaction (their files are deleted while the rows are locked). */
  uploadBatchSize: 25,
  /** Most rows one task handles in one run. */
  maxRowsPerTask: 100_000,
  /** Time budget of a whole run; the route allows 300 s and deploy/cron-job.sh waits 330 s. */
  budgetMs: 240_000,
});

export type MaintenanceOptions = {
  /** The run's clock for every retention cutoff (default: now). */
  now?: Date;
  client?: PrismaClient;
  /**
   * Storage for the upload task (default getStorage(), only resolved when there is a file to delete). Storage not
   * configured: the uploads task is skipped (logged maintenance_uploads_skipped), not failed.
   */
  storage?: StorageDriver;
  /** Run only these tasks (still in the canonical order). Default: all. */
  tasks?: readonly MaintenanceTask[];
  batchSize?: number;
  uploadBatchSize?: number;
  maxRowsPerTask?: number;
  budgetMs?: number;
  /** Milliseconds clock for the time budget (tests). Default Date.now. */
  clock?: () => number;
};

export function emptyMaintenanceCounts(): MaintenanceCounts {
  const counts = {} as MaintenanceCounts;
  for (const task of MAINTENANCE_TASKS) counts[MAINTENANCE_COUNT_KEYS[task]] = 0;
  return counts;
}

type TaskContext = {
  client: PrismaClient;
  cutoffs: MaintenanceCutoffs;
  storage: () => Promise<StorageDriver>;
  /** Adds to this task's count as batches complete, so a task that fails half-way still reports its progress. */
  add: (n: number) => void;
  uploadFailures: Set<string>;
};

async function runTask(task: MaintenanceTask, ctx: TaskContext, limits: BatchLimits): Promise<BatchOutcome> {
  const { client, cutoffs } = ctx;
  const counted = (batch: (limit: number) => Promise<number>) =>
    runBatches(async (limit) => {
      const n = await batch(limit);
      ctx.add(n);
      return { handled: n };
    }, limits);
  switch (task) {
    case "tickets":
      return counted((limit) => closeResolvedTicketsBatch(client, cutoffs, limit));
    case "emails":
      return counted((limit) => redactSentEmailsBatch(client, cutoffs, limit));
    case "uploads":
      return runBatches(async (limit) => {
        let result;
        try {
          result = await deleteStaleUploadsBatch(client, cutoffs, limit, ctx.storage, ctx.uploadFailures);
        } catch (error) {
          if (!(error instanceof StorageError && error.code === "not_configured")) throw error;
          log.info("maintenance_uploads_skipped", { reason: "not_configured" });
          return { handled: 0 };
        }
        ctx.add(result.deleted);
        for (const id of result.failedIds) ctx.uploadFailures.add(id);
        // Storage refused every file of a full batch: it is down or misconfigured, so stop instead of hammering it.
        const refusedAll = result.deleted === 0 && result.failedIds.length > 0 && result.handled >= limit;
        return { handled: result.handled, stop: refusedAll };
      }, limits);
    default:
      return counted((limit) => purgeBatch(client, task, cutoffs, limit));
  }
}

/** Runs the maintenance tasks once (see the module comment). Never throws for a failing task; see `failed`. */
export async function runMaintenance(opts: MaintenanceOptions = {}): Promise<MaintenanceResult> {
  const client = opts.client ?? defaultDb;
  const clock = opts.clock ?? Date.now;
  const cutoffs = maintenanceCutoffs(opts.now ?? new Date());
  const tasks = opts.tasks ? MAINTENANCE_TASKS.filter((t) => opts.tasks?.includes(t)) : [...MAINTENANCE_TASKS];
  const batchSize = opts.batchSize ?? MAINTENANCE_DEFAULTS.batchSize;
  const uploadBatchSize = opts.uploadBatchSize ?? MAINTENANCE_DEFAULTS.uploadBatchSize;
  const maxRows = opts.maxRowsPerTask ?? MAINTENANCE_DEFAULTS.maxRowsPerTask;
  const started = clock();
  const deadline = started + (opts.budgetMs ?? MAINTENANCE_DEFAULTS.budgetMs);

  let driver: Promise<StorageDriver> | null = opts.storage ? Promise.resolve(opts.storage) : null;
  const storage = (): Promise<StorageDriver> => (driver ??= getStorage());
  const counts = emptyMaintenanceCounts();
  const uploadFailures = new Set<string>();
  const more: MaintenanceTask[] = [];
  const failed: MaintenanceTask[] = [];

  for (const [index, task] of tasks.entries()) {
    const key = MAINTENANCE_COUNT_KEYS[task];
    const taskStart = clock();
    const share = Math.max(0, deadline - taskStart) / (tasks.length - index);
    const limits: BatchLimits = {
      batchSize: task === "uploads" ? uploadBatchSize : batchSize,
      maxRows,
      deadline: taskStart + share,
      clock,
    };
    const ctx: TaskContext = { client, cutoffs, storage, add: (n) => (counts[key] += n), uploadFailures };
    try {
      const outcome = await runTask(task, ctx, limits);
      if (outcome.more) more.push(task);
    } catch (error) {
      failed.push(task);
      log.error("maintenance_task_failed", { task, error });
    }
    // Files that could not be deleted fail the run, so a broken bucket policy (no s3:DeleteObject) gets noticed.
    if (task === "uploads" && uploadFailures.size > 0 && !failed.includes(task)) failed.push(task);
  }

  const result: MaintenanceResult = { ...counts };
  if (uploadFailures.size > 0) result.uploadsFailed = uploadFailures.size;
  if (more.length > 0) result.more = more;
  if (failed.length > 0) result.failed = failed;
  const busy = Object.values(counts).some((n) => n > 0) || more.length > 0 || failed.length > 0;
  if (busy) log.info("maintenance_run", { ...result, tookMs: Math.max(0, clock() - started) });
  return result;
}
