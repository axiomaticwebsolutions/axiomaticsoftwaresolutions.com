/**
 * Retention rules of the daily maintenance job (lib/jobs/maintenance.ts; docs/decisions.md "Phase 7 decisions").
 * One run computes every cutoff once from its own clock, so the whole run applies one consistent set of boundaries.
 *
 * Boundaries: "older than N" is strict (a row exactly N old waits for the next run), except where another part of the
 * app already uses an inclusive rule and the job must agree with it:
 * - tickets: the portal and the console show a RESOLVED ticket as closed once `now - resolvedAt >= 14 days`
 *   (deriveTicketStatus, closedCutoff), so the job stores CLOSED for `resolvedAt <= now - 14 days`;
 * - rate-limit buckets: the store treats `resetAt <= now` as ended, so those rows are purged.
 * Pending uploads use the portal's own limit: an upload is attachable while `createdAt >= now - 24 h`, so only rows
 * strictly older than that are deleted (the job never deletes a file the portal would still accept).
 */
import { addCalendarMonths, DAY_MS } from "@/lib/dates";
import { PENDING_UPLOAD_MAX_AGE_MS } from "@/lib/portal/uploads";
import { TICKET_AUTO_CLOSE_DAYS } from "@/lib/validation/tickets";

export const RETENTION = Object.freeze({
  /** RESOLVED tickets are stored as CLOSED this many days after resolvedAt (no email; customers already see Closed). */
  ticketCloseDays: TICKET_AUTO_CLOSE_DAYS,
  /** PENDING (never attached) uploads are deleted, file and row, once older than this. */
  pendingUploadMs: PENDING_UPLOAD_MAX_AGE_MS,
  /** SENT outbox emails lose their bodies this many days after sentAt (the row stays for dedupe and history). */
  sentEmailDays: 30,
  /** Sessions are deleted this many days after they expired or were revoked. */
  deadSessionDays: 30,
  /** Auth tokens (codes, reset/verify/invite links) are deleted this many days after they expired or were used. */
  deadAuthTokenDays: 30,
  /** Account activity (the portal's Owner-only log) is kept for this many calendar months. */
  activityMonths: 24,
  /** Webhook delivery attempts are kept for this many days; WebhookEvent rows (idempotency, replay) are never purged. */
  webhookDeliveryDays: 180,
});

export type MaintenanceCutoffs = {
  /** The run's clock. */
  now: Date;
  /** RESOLVED tickets with resolvedAt at or before this are closed. */
  ticketsResolvedAtOrBefore: Date;
  /** PENDING uploads created before this are deleted. */
  uploadsCreatedBefore: Date;
  /** SENT emails with sentAt before this are redacted. */
  emailsSentBefore: Date;
  /** Rate-limit buckets whose window ended at or before this are deleted (= now). */
  rateLimitsResetAtOrBefore: Date;
  /** Sessions that expired or were revoked before this are deleted. */
  sessionsDeadBefore: Date;
  /** Auth tokens that expired or were used before this are deleted. */
  authTokensDeadBefore: Date;
  /** Account activity created before this is deleted (24 calendar months back, in IST). */
  activityCreatedBefore: Date;
  /** Webhook deliveries received before this are deleted. */
  webhookDeliveriesReceivedBefore: Date;
};

const daysBefore = (now: Date, days: number): Date => new Date(now.getTime() - days * DAY_MS);

/** Every boundary of one maintenance run (see the module comment for which comparisons are inclusive). */
export function maintenanceCutoffs(now: Date): MaintenanceCutoffs {
  if (Number.isNaN(now.getTime())) throw new RangeError("maintenanceCutoffs: invalid date");
  return {
    now,
    ticketsResolvedAtOrBefore: daysBefore(now, RETENTION.ticketCloseDays),
    uploadsCreatedBefore: new Date(now.getTime() - RETENTION.pendingUploadMs),
    emailsSentBefore: daysBefore(now, RETENTION.sentEmailDays),
    rateLimitsResetAtOrBefore: now,
    sessionsDeadBefore: daysBefore(now, RETENTION.deadSessionDays),
    authTokensDeadBefore: daysBefore(now, RETENTION.deadAuthTokenDays),
    activityCreatedBefore: addCalendarMonths(now, -RETENTION.activityMonths),
    webhookDeliveriesReceivedBefore: daysBefore(now, RETENTION.webhookDeliveryDays),
  };
}
