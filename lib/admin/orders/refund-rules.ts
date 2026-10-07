/**
 * Pure refund rules (decisions.md rule 11 and Phase 6 "Refunds"), shared by the refund service, the order detail and
 * unit tests: which payment paid the order, how much is still refundable, and whether a license still carries the terms
 * an order item gave it (so a refund may restore the terms from before).
 */

/** Order statuses an admin refund can start from. REVIEW covers captured payments that issued nothing (mismatch). */
export const REFUNDABLE_ORDER_STATUSES = ["PAID", "PARTIALLY_REFUNDED", "REVIEW"] as const;
const CAPTURED = new Set(["CAPTURED", "REFUNDED"]);
/** Refunds that count against the payment: issued (PENDING) or confirmed. FAILED ones gave nothing back. */
const COUNTED_REFUNDS = new Set(["PENDING", "PROCESSED"]);

export type PaymentLike = {
  id: string;
  status: string;
  providerOrderId: string;
  providerPaymentId: string | null;
  amountPaise: number;
  capturedAt: Date | null;
  createdAt: Date;
};

/**
 * The attempt whose capture paid the order (as lib/payments/webhook.ts decides for refund.processed): the only
 * capture; else the one the order's `fulfilled` event named; else the capture recorded at Order.paidAt; else the
 * earliest capture. Null when nothing was captured.
 */
export function pickPayingPayment<P extends PaymentLike>(
  payments: readonly P[],
  paidAt: Date | null,
  fulfilledProviderOrderId: string | null = null,
): P | null {
  const captured = payments
    .filter((p) => CAPTURED.has(p.status))
    .sort(
      (a, b) =>
        (a.capturedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.capturedAt?.getTime() ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt.getTime() - b.createdAt.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  if (captured.length <= 1) return captured[0] ?? null;
  const byEvent = fulfilledProviderOrderId ? captured.find((p) => p.providerOrderId === fulfilledProviderOrderId) : undefined;
  if (byEvent) return byEvent;
  const paid = paidAt?.getTime();
  return captured.find((p) => paid !== undefined && p.capturedAt?.getTime() === paid) ?? captured[0] ?? null;
}

/** Paise already refunded or on their way back for one payment. */
export function refundedSoFar(refunds: readonly { amountPaise: number; status: string }[]): number {
  return refunds.filter((r) => COUNTED_REFUNDS.has(r.status)).reduce((sum, r) => sum + r.amountPaise, 0);
}

/** What a full refund returns now: the payment minus refunds issued (never negative). */
export function refundableAmount(payment: { amountPaise: number }, refunds: readonly { amountPaise: number; status: string }[]): number {
  return Math.max(0, payment.amountPaise - refundedSoFar(refunds));
}

export function isRefundableStatus(status: string): boolean {
  return (REFUNDABLE_ORDER_STATUSES as readonly string[]).includes(status);
}

/** OrderItem.termsBefore / termsAfter (lib/licensing/fulfil.ts TermsSnapshot), read defensively from JSON. */
export type TermsSnapshotLike = {
  planId: string;
  status: string;
  expiresAt: string | null;
  updatesUntil: string;
  deviceLimit: number;
};

export function readTermsSnapshot(json: unknown): TermsSnapshotLike | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const v = json as Record<string, unknown>;
  if (typeof v.planId !== "string" || typeof v.status !== "string" || typeof v.updatesUntil !== "string") return null;
  if (!(v.expiresAt === null || typeof v.expiresAt === "string")) return null;
  if (typeof v.deviceLimit !== "number" || !Number.isSafeInteger(v.deviceLimit) || v.deviceLimit < 0) return null;
  if (Number.isNaN(Date.parse(v.updatesUntil)) || (typeof v.expiresAt === "string" && Number.isNaN(Date.parse(v.expiresAt)))) return null;
  return { planId: v.planId, status: v.status, expiresAt: v.expiresAt, updatesUntil: v.updatesUntil, deviceLimit: v.deviceLimit };
}

const sameInstant = (a: string | null, b: string | null) =>
  a === null || b === null ? a === b : new Date(a).getTime() === new Date(b).getTime();

/** True when the license still carries exactly the terms the item left it with. */
export function termsMatch(current: TermsSnapshotLike, after: TermsSnapshotLike): boolean {
  return (
    current.planId === after.planId &&
    current.status === after.status &&
    current.deviceLimit === after.deviceLimit &&
    sameInstant(current.expiresAt, after.expiresAt) &&
    sameInstant(current.updatesUntil, after.updatesUntil)
  );
}

export type ReversalItem = { id: string; kind: string; fulfilledAt: Date | null; targetLicenseId: string | null };

/** Renewal / add-on / upgrade lines a full refund reverses, newest effect first (reverse of fulfilment order). */
export function reversalOrder<I extends ReversalItem>(items: readonly I[]): I[] {
  return items
    .filter((i) => i.kind !== "NEW" && i.fulfilledAt !== null && i.targetLicenseId !== null)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** A trial converted by this order (UPGRADE from TRIAL): a refund revokes it rather than restoring an ended trial. */
export function isTrialConversion(kind: string, before: TermsSnapshotLike): boolean {
  return kind === "UPGRADE" && before.status === "TRIAL";
}
