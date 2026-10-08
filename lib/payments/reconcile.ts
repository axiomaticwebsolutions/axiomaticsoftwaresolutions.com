/**
 * Reconciliation (docs/decisions.md Phase 3 Payments): orders whose webhook never arrived. Run by /api/cron/reconcile
 * every 10 minutes. Picks payment attempts of the configured provider older than 15 minutes, asks the provider for the
 * provider order's payments and feeds them through processPaymentEvent() with the event id "reconcile:<paymentId>":
 * 1. Settling (oldest first, up to 7 days): open attempts (CREATED, AUTHORIZED, PENDING) of CONFIRMING/PENDING orders,
 *    and AUTHORIZED attempts (a verified return: the provider signed a successful payment) whatever the unpaid order's
 *    status, so a paid customer is never left on FAILED or CANCELED.
 * 2. Awaiting (newest first, up to 72 hours): open attempts of AWAITING_PAYMENT orders.
 * 3. Closed (newest first, up to 72 hours): attempts of FAILED and CANCELED orders, and FAILED/CANCELED attempts of
 *    orders retried since, because their provider order can still capture (a UPI payment completing after the
 *    checkout was closed, a retry inside Razorpay's checkout after a failure). Only captures are applied for these;
 *    each is re-checked on a thinning schedule (closedAttemptDue).
 * Per provider order:
 * - a captured payment -> payment.captured (fulfils exactly like the webhook; captured after FAILED/CANCELED still
 *   pays the order; idempotent through WebhookEvent);
 * - only failed payments -> payment.failed for each (the handler ignores all but the latest attempt's own payment);
 * - anything still in flight (created/authorized) or refunded is left alone.
 * Events already recorded under their reconcile id are skipped without a delivery row, so repeated runs stay quiet.
 *
 * Refunds (reconcilePendingRefunds, same cron): a refund still PENDING a day after it was issued means its
 * refund.processed or refund.failed webhook may have been lost. From one to 30 days old, each is asked about every 6
 * hours (provider.fetchRefund) and a final state is fed through processPaymentEvent() as
 * "reconcile:<refundId>:<processed|failed>", exactly as the webhook would apply it.
 *
 * Only attempts and refunds the ACTIVE keys can reach are looked at (lib/payments/key-scope.ts: the active key id, a
 * null one from before 2026-10-08, or another Razorpay key id of the same mode, so regenerated keys of the same account
 * keep covering earlier payments; a key of another account answers "not found" and counts under `errors`). When
 * payments are not configured, both runs are skipped (`skipped: "not_configured"`, provider null) and the cron route
 * stays 200.
 */
import "server-only";
import { OrderStatus, PaymentStatus, RefundStatus } from "@/generated/prisma/client";
import { DAY_MS } from "@/lib/dates";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { activePaymentProviderOrNull } from "./index";
import { reachablePaymentKeys } from "./key-scope";
import type { NormalizedEvent, NormalizedPayment, NormalizedRefund, PaymentProvider } from "./types";
import { processPaymentEvent, type WebhookResult } from "./webhook";

export const RECONCILE_MIN_AGE_MS = 15 * 60_000;
export const RECONCILE_CONFIRMING_MAX_AGE_MS = 7 * DAY_MS;
export const RECONCILE_AWAITING_MAX_AGE_MS = 3 * DAY_MS;
export const RECONCILE_CLOSED_MAX_AGE_MS = 3 * DAY_MS;
/** The scheduler's period (closedAttemptDue picks one run per check). */
export const RECONCILE_INTERVAL_MS = 10 * 60_000;
export const RECONCILE_DEFAULT_LIMIT = 50;
const RECONCILE_MAX_LIMIT = 500;
/** Closed attempts looked at per run before the schedule filter (bounded query). */
const CLOSED_CANDIDATES_MAX = 5000;
const HOUR_MS = 60 * 60_000;
const OPEN_PAYMENT_STATES = [PaymentStatus.CREATED, PaymentStatus.AUTHORIZED, PaymentStatus.PENDING];
/** Closed orders' attempts that may still capture (AUTHORIZED ones are already in the settling group). */
const CLOSED_PAYMENT_STATES = [PaymentStatus.CREATED, PaymentStatus.PENDING, PaymentStatus.FAILED, PaymentStatus.CANCELED];

export type ReconcileOptions = {
  now?: Date;
  /** Payment attempts checked per run (default 50, at most 500). */
  limit?: number;
  /** Defaults to the configured provider (tests pass their own instance). */
  provider?: PaymentProvider;
};

export type ReconcileSummary = {
  /** The active provider's key; null when payments are not configured (then `skipped` says so). */
  provider: string | null;
  skipped?: "not_configured";
  /** Payment attempts asked about. */
  checked: number;
  /** Events fed through the handler, by result. */
  results: Partial<Record<WebhookResult, number>>;
  /** Provider calls or events that failed; the run carries on with the next payment attempt. */
  errors: number;
};

export function reconcileEventId(providerPaymentId: string): string {
  return `reconcile:${providerPaymentId}`;
}

/** PENDING refunds are asked about from this age (a lost refund.processed / refund.failed webhook)... */
export const REFUND_RECONCILE_MIN_AGE_MS = DAY_MS;
/** ...until this age. */
export const REFUND_RECONCILE_MAX_AGE_MS = 30 * DAY_MS;
const REFUND_CHECK_EVERY_MS = 6 * 60 * 60_000;

export function refundReconcileEventId(providerRefundId: string, status: "processed" | "failed"): string {
  return `reconcile:${providerRefundId}:${status}`;
}

/** Whether a PENDING refund of this age is checked in a run: from one day to 30 days old, once every 6 hours. */
export function pendingRefundDue(ageMs: number): boolean {
  if (!Number.isFinite(ageMs) || ageMs < REFUND_RECONCILE_MIN_AGE_MS || ageMs > REFUND_RECONCILE_MAX_AGE_MS) return false;
  return ageMs % REFUND_CHECK_EVERY_MS < RECONCILE_INTERVAL_MS;
}

function eventFor(type: "payment.captured" | "payment.failed", providerOrderId: string, p: NormalizedPayment): NormalizedEvent {
  const event: NormalizedEvent = {
    id: reconcileEventId(p.providerPaymentId),
    type,
    providerOrderId,
    providerPaymentId: p.providerPaymentId,
    amountPaise: p.amountPaise,
    currency: p.currency,
  };
  if (p.method) event.method = p.method;
  if (type === "payment.failed" && p.failureReason) event.failureReason = p.failureReason;
  return event;
}

/** The events a provider order's payments call for (see the module comment). */
export function reconcileEvents(providerOrderId: string, payments: readonly NormalizedPayment[]): NormalizedEvent[] {
  const captured = payments.filter((p) => p.status === "captured");
  if (captured.length > 0) return captured.map((p) => eventFor("payment.captured", providerOrderId, p));
  if (payments.length > 0 && payments.every((p) => p.status === "failed")) {
    return payments.map((p) => eventFor("payment.failed", providerOrderId, p));
  }
  return [];
}

/**
 * Whether a FAILED/CANCELED order's attempt of this age is checked in a run: every run for its first 2 hours (when a
 * late capture is most likely), then once an hour until 24 hours, then every 6 hours until 72 hours. About 40 provider
 * calls per abandoned checkout instead of one every run, so recent ones do not starve older ones of the run limit.
 */
export function closedAttemptDue(ageMs: number): boolean {
  if (!Number.isFinite(ageMs) || ageMs < RECONCILE_MIN_AGE_MS || ageMs > RECONCILE_CLOSED_MAX_AGE_MS) return false;
  if (ageMs < 2 * HOUR_MS) return true;
  const every = ageMs < DAY_MS ? HOUR_MS : 6 * HOUR_MS;
  return ageMs % every < RECONCILE_INTERVAL_MS;
}

/** The summary of a run skipped because payments are not configured (one info line per run). */
function notConfigured(event: string): ReconcileSummary {
  log.info(event, { reason: "not_configured" });
  return { provider: null, skipped: "not_configured", checked: 0, results: {}, errors: 0 };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return RECONCILE_DEFAULT_LIMIT;
  return Math.min(RECONCILE_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

type AttemptRow = { id: string; orderId: string; providerOrderId: string };
type Attempt = AttemptRow & { closed: boolean };

/** The attempts to check this run: settling first, then awaiting, then closed (see the module comment). */
async function attemptsToCheck(providerKey: string, keyId: string, now: Date, limit: number): Promise<Attempt[]> {
  const sameKeys = reachablePaymentKeys(keyId);
  const olderThan = new Date(now.getTime() - RECONCILE_MIN_AGE_MS);
  const since = (maxAgeMs: number) => new Date(now.getTime() - maxAgeMs);
  const select = { id: true, orderId: true, providerOrderId: true } as const;
  const picked: Attempt[] = [];
  const seen = new Set<string>();
  const add = (rows: readonly AttemptRow[], closed: boolean) => {
    for (const row of rows) {
      if (picked.length >= limit) return;
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      picked.push({ id: row.id, orderId: row.orderId, providerOrderId: row.providerOrderId, closed });
    }
  };

  const settling = await db.payment.findMany({
    where: {
      provider: providerKey,
      AND: [sameKeys],
      createdAt: { lte: olderThan, gte: since(RECONCILE_CONFIRMING_MAX_AGE_MS) },
      OR: [
        { status: { in: OPEN_PAYMENT_STATES }, order: { status: { in: [OrderStatus.CONFIRMING, OrderStatus.PENDING] } } },
        {
          status: PaymentStatus.AUTHORIZED,
          order: { status: { in: [OrderStatus.AWAITING_PAYMENT, OrderStatus.FAILED, OrderStatus.CANCELED] } },
        },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: limit,
    select,
  });
  add(settling, false);
  if (picked.length >= limit) return picked;

  const awaiting = await db.payment.findMany({
    where: {
      provider: providerKey,
      AND: [sameKeys],
      status: { in: OPEN_PAYMENT_STATES },
      createdAt: { lte: olderThan, gte: since(RECONCILE_AWAITING_MAX_AGE_MS) },
      order: { status: OrderStatus.AWAITING_PAYMENT },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select,
  });
  add(awaiting, false);
  if (picked.length >= limit) return picked;

  const closed = await db.payment.findMany({
    where: {
      provider: providerKey,
      AND: [sameKeys],
      createdAt: { lte: olderThan, gte: since(RECONCILE_CLOSED_MAX_AGE_MS) },
      OR: [
        { status: { in: CLOSED_PAYMENT_STATES }, order: { status: { in: [OrderStatus.FAILED, OrderStatus.CANCELED] } } },
        // An earlier attempt that failed or was closed, of an order that was retried since.
        {
          status: { in: [PaymentStatus.FAILED, PaymentStatus.CANCELED] },
          order: { status: { in: [OrderStatus.AWAITING_PAYMENT, OrderStatus.PENDING, OrderStatus.CONFIRMING] } },
        },
      ],
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CLOSED_CANDIDATES_MAX,
    select: { ...select, createdAt: true },
  });
  add(
    closed.filter((row) => closedAttemptDue(now.getTime() - row.createdAt.getTime())),
    true,
  );
  return picked;
}

/** Checks stuck orders with the provider and applies what it reports. Never throws for one bad order. */
export async function reconcileStuckOrders(opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const now = opts.now ?? new Date();
  const limit = clampLimit(opts.limit);
  const provider = opts.provider ?? (await activePaymentProviderOrNull());
  if (!provider) return notConfigured("reconcile_skipped");
  const attempts = await attemptsToCheck(provider.key, provider.keyId, now, limit);

  const summary: ReconcileSummary = { provider: provider.key, checked: 0, results: {}, errors: 0 };
  for (const attempt of attempts) {
    summary.checked += 1;
    let payments: NormalizedPayment[];
    try {
      payments = await provider.fetchOrderPayments(attempt.providerOrderId);
    } catch (error) {
      summary.errors += 1;
      const code = error instanceof Error ? ((error as { code?: unknown }).code ?? error.name) : "unknown";
      log.warn("reconcile_provider_failed", { orderId: attempt.orderId, paymentId: attempt.id, reason: String(code) });
      continue;
    }
    const events = reconcileEvents(attempt.providerOrderId, payments).filter(
      // A failed or canceled order only changes when money was taken.
      (event) => !attempt.closed || event.type === "payment.captured",
    );
    for (const event of events) {
      const seen = await db.webhookEvent.findUnique({
        where: { provider_id: { provider: provider.key, id: event.id } },
        select: { id: true },
      });
      if (seen) continue;
      try {
        const { result } = await processPaymentEvent(provider.key, event, { now });
        summary.results[result] = (summary.results[result] ?? 0) + 1;
      } catch (error) {
        summary.errors += 1;
        log.error("reconcile_event_failed", { orderId: attempt.orderId, eventId: event.id, error: error instanceof Error ? error.name : "unknown" });
      }
    }
  }
  if (summary.checked > 0) log.info("reconcile_run", { provider: summary.provider, checked: summary.checked, errors: summary.errors, results: summary.results });
  return summary;
}

/**
 * Asks the provider about refunds still PENDING after a day (see the module comment) and applies a final state through
 * processPaymentEvent(). Never throws for one bad refund.
 */
export async function reconcilePendingRefunds(opts: ReconcileOptions = {}): Promise<ReconcileSummary> {
  const now = opts.now ?? new Date();
  const limit = clampLimit(opts.limit);
  const provider = opts.provider ?? (await activePaymentProviderOrNull());
  if (!provider) return notConfigured("reconcile_refunds_skipped");
  const candidates = await db.refund.findMany({
    where: {
      status: RefundStatus.PENDING,
      providerRefundId: { not: null },
      createdAt: {
        lte: new Date(now.getTime() - REFUND_RECONCILE_MIN_AGE_MS),
        gte: new Date(now.getTime() - REFUND_RECONCILE_MAX_AGE_MS),
      },
      payment: { provider: provider.key, ...reachablePaymentKeys(provider.keyId) },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: CLOSED_CANDIDATES_MAX,
    select: { id: true, providerRefundId: true, createdAt: true, payment: { select: { orderId: true, providerOrderId: true, providerPaymentId: true } } },
  });
  const due = candidates.filter((r) => pendingRefundDue(now.getTime() - r.createdAt.getTime())).slice(0, limit);

  const summary: ReconcileSummary = { provider: provider.key, checked: 0, results: {}, errors: 0 };
  for (const refund of due) {
    const providerRefundId = refund.providerRefundId;
    if (!providerRefundId) continue;
    summary.checked += 1;
    let remote: NormalizedRefund;
    try {
      remote = await provider.fetchRefund(providerRefundId);
    } catch (error) {
      summary.errors += 1;
      const code = error instanceof Error ? ((error as { code?: unknown }).code ?? error.name) : "unknown";
      log.warn("reconcile_refund_provider_failed", { orderId: refund.payment.orderId, refundId: refund.id, reason: String(code) });
      continue;
    }
    if (remote.status === "pending") continue;
    const event: NormalizedEvent = {
      id: refundReconcileEventId(providerRefundId, remote.status),
      type: remote.status === "processed" ? "refund.processed" : "refund.failed",
      providerOrderId: refund.payment.providerOrderId,
      providerPaymentId: refund.payment.providerPaymentId ?? remote.providerPaymentId,
      providerRefundId,
      amountPaise: remote.amountPaise,
      currency: remote.currency,
    };
    const seen = await db.webhookEvent.findUnique({ where: { provider_id: { provider: provider.key, id: event.id } }, select: { id: true } });
    if (seen) continue;
    try {
      const { result } = await processPaymentEvent(provider.key, event, { now });
      summary.results[result] = (summary.results[result] ?? 0) + 1;
    } catch (error) {
      summary.errors += 1;
      log.error("reconcile_event_failed", { orderId: refund.payment.orderId, eventId: event.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  if (summary.checked > 0) log.info("reconcile_refunds_run", { provider: summary.provider, checked: summary.checked, errors: summary.errors, results: summary.results });
  return summary;
}
