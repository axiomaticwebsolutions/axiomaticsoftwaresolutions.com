/**
 * Admin refunds (decisions.md Phase 6 "Refunds" and rule 11; api-contracts section 7: POST /api/admin/orders/:id/refund).
 *
 * The reason and typed order id are checked first (validateDestructive: 403 / 422, no provider call). Then ONE
 * transaction (runDestructive) does, in order:
 * 1. `SELECT ... FOR UPDATE` on the order: a second click waits here and then finds the refund already issued
 *    (409 `already_refunded`), so it never reaches the provider.
 * 2. Re-checks the order (PAID, PARTIALLY_REFUNDED, or REVIEW with a captured payment) and the amount left on the
 *    payment that paid it (payment minus PENDING/PROCESSED refunds). The UI sends no amount: a full refund.
 * 3. Asks the payment provider for the refund (the first external effect; a refusal rolls everything back, 502).
 * 4. Refund(PENDING, providerRefundId, credit note from nextCreditNoteNumber when the order has a tax invoice; a
 *    REVIEW order that was never invoiced gets none, as GST credit notes reference an invoice), then for a full refund: restores
 *    OrderItem.termsBefore of RENEWAL / ADDON / UPGRADE items in reverse item order while the license still matches
 *    termsAfter (a converted trial is revoked instead), revokes the licenses NEW items issued (revokeOrderLicenses),
 *    and sends the order to REVIEW when a change could not be reversed. Members get an in-app notice and the order
 *    email the "refund_issued" email (outbox). runDestructive writes exactly one audit row.
 * `refund.processed` (lib/payments/webhook.ts) later marks the refund PROCESSED and the order REFUNDED; with the mock
 * provider the signed webhook is delivered to the webhook route a moment after the commit, as Razorpay would.
 * `refund.failed` marks it FAILED and the order REVIEW; refunding again finds the earlier license reversal in place
 * (the license already carries termsBefore, or a converted trial is already revoked for this order) and does not
 * count it as a mismatch.
 *
 * Duplicate payments: `paymentId` names one captured payment of the order. When it is not the payment that paid the
 * order (a second capture, or a capture of an order that was never fulfilled), only that payment is refunded: no
 * credit note, no license change, order status unchanged, audited "Refunded duplicate payment".
 */
import "server-only";
import { LicenseStatus, OrderStatus, RefundStatus, type ItemKind, type StaffRole } from "@/generated/prisma/client";
import { DESTRUCTIVE_AUDIT_ACTIONS, runDestructive, validateDestructive } from "@/lib/admin/destructive";
import type { AuditActor } from "@/lib/audit";
import { getSettings } from "@/lib/config";
import { nextCreditNoteNumber } from "@/lib/counters";
import { db as defaultDb, type Tx } from "@/lib/db";
import { enqueueEmail, kickEmailDispatch } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { getEnv, isProduction } from "@/lib/env";
import { ApiError, errors } from "@/lib/http";
import { trimDevicesToLimit } from "@/lib/licensing/device-limit";
import { revokeOrderLicenses, SYSTEM_EVENT_ACTOR, termsSnapshot } from "@/lib/licensing/fulfil";
import { log } from "@/lib/log";
import { formatINR } from "@/lib/money";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { orderStatusPath, signOrderToken } from "@/lib/orders/token";
import { getPaymentProvider, isPaymentProviderKey, PaymentProviderError, type PaymentProvider } from "@/lib/payments";
import { mockAdoptCapturedPayment } from "@/lib/payments/mock";
import { scheduleMockWebhook } from "@/lib/payments/mock-delivery";
import { fulfilledProviderOrderId } from "./detail";
import type { OrderStatusValue, RefundResponse } from "./model";
import {
  isRefundableStatus,
  isTrialConversion,
  pickPayingPayment,
  readTermsSnapshot,
  refundedSoFar,
  reversalOrder,
  termsMatch,
  type TermsSnapshotLike,
} from "./refund-rules";

export const ALREADY_REFUNDED_MESSAGE = "This order has already been refunded.";
export const NOT_REFUNDABLE_MESSAGE = "Only paid orders can be refunded.";
export const NO_CAPTURE_MESSAGE = "This order has no captured payment to refund.";
export const NOT_ORDER_PAYMENT_MESSAGE = "This payment doesn\u2019t belong to this order.";
export const DUPLICATE_REFUNDED_MESSAGE = "This payment has already been refunded.";
export const DUPLICATE_REFUND_ACTION = "Refunded duplicate payment";
export const PROVIDER_REFUND_FAILED_MESSAGE = "The payment provider couldn\u2019t process the refund. Nothing was changed.";
/** The provider call happens inside the transaction (after the row lock), so allow for its own timeout. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 45_000 } as const;
/** refund.processed from the mock follows the commit after this long (like a provider's asynchronous webhook). */
export const MOCK_REFUND_WEBHOOK_DELAY_MS = 1_500;

const KIND_LABELS: Record<ItemKind, string> = { NEW: "Purchase", RENEWAL: "Renewal", ADDON: "Add-on", UPGRADE: "Upgrade" };
const LICENSE_STATUSES = new Set<string>(Object.values(LicenseStatus));
const CAPTURED_PAYMENT = new Set<string>(["CAPTURED", "REFUNDED"]);
/** Order statuses a duplicate payment can be refunded from (the order itself is not touched). */
const DUPLICATE_REFUNDABLE = new Set<string>([OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED, OrderStatus.REVIEW, OrderStatus.REFUNDED]);

export type IssueRefundInput = {
  orderId: string;
  staff: { id: string; role: StaffRole };
  actor: AuditActor;
  body: { reason?: string | null; confirmId?: string | null; amountPaise?: number | null; paymentId?: string | null };
  now?: Date;
  /** Tests: the provider to refund through (default: the adapter of the payment's provider). */
  provider?: PaymentProvider;
};

type Mismatch = { licenseId: string; kind: ItemKind };
type Reversal = { revoked: string[]; restored: string[]; mismatches: Mismatch[] };

export type RefundOutcome = RefundResponse & {
  /** Audit detail (also returned to tests). */
  auditDetail: string;
  provider: string;
  providerOrderId: string;
  providerPaymentId: string;
  providerRefundId: string;
};

let mockDelivery: boolean | null = null;
/** Turns the mock refund.processed delivery on/off (tests); null = default (on outside Vitest and production). */
export function setMockRefundDelivery(enabled: boolean | null): void {
  mockDelivery = enabled;
}
function mockDeliveryEnabled(): boolean {
  if (isProduction()) return false;
  return mockDelivery ?? !process.env.VITEST;
}

type PayingPayment = {
  id: string;
  provider: string;
  providerOrderId: string;
  providerPaymentId: string;
  amountPaise: number;
  method: string | null;
};

/** The provider's refund id. Provider refusals become 502 `provider_refund_failed` (the transaction rolls back). */
async function requestProviderRefund(provider: PaymentProvider, payment: PayingPayment, amountPaise: number, refundedPaise: number, orderId: string): Promise<string> {
  // A neutral note for the provider dashboard; the staff reason stays in the audit log.
  const request = () => provider.refund({ providerPaymentId: payment.providerPaymentId, amountPaise, reason: `Refund for order ${orderId}` });
  try {
    try {
      return (await request()).providerRefundId;
    } catch (error) {
      // The mock's in-memory ledger forgets payments on a dev server restart (and never held seeded ones).
      if (!(error instanceof PaymentProviderError) || error.code !== "not_found" || provider.key !== "mock" || isProduction()) throw error;
      mockAdoptCapturedPayment({ ...payment, refundedPaise });
      return (await request()).providerRefundId;
    }
  } catch (error) {
    if (!(error instanceof PaymentProviderError)) throw error;
    log.warn("admin_refund_provider_refused", { orderId, paymentId: payment.id, provider: provider.key, code: error.code });
    const detail = error.code === "invalid_request" || error.code === "not_found" ? ` (${error.message})` : "";
    throw new ApiError(502, "provider_refund_failed", `${PROVIDER_REFUND_FAILED_MESSAGE}${detail}`, { details: { providerCode: error.code } });
  }
}

type ReversibleItem = {
  id: string;
  kind: ItemKind;
  fulfilledAt: Date | null;
  targetLicenseId: string | null;
  termsBefore: unknown;
  termsAfter: unknown;
};

/**
 * Full-refund reversal: renewal/add-on/upgrade effects in reverse item order (only while the license still carries the
 * item's termsAfter), then the licenses NEW items issued. Devices above a restored lower limit are deactivated.
 */
async function reverseOrderEffects(tx: Tx, orderId: string, items: readonly ReversibleItem[], at: Date): Promise<Reversal> {
  const note = `Order ${orderId} refunded.`;
  const out: Reversal = { revoked: [], restored: [], mismatches: [] };
  for (const item of reversalOrder(items)) {
    const licenseId = item.targetLicenseId as string;
    const before = readTermsSnapshot(item.termsBefore);
    const after = readTermsSnapshot(item.termsAfter);
    if (!before || !after || !LICENSE_STATUSES.has(before.status)) {
      out.mismatches.push({ licenseId, kind: item.kind });
      continue;
    }
    await tx.$queryRaw`SELECT "id" FROM "License" WHERE "id" = ${licenseId} FOR UPDATE`;
    const license = await tx.license.findUnique({ where: { id: licenseId } });
    if (!license || !termsMatch(termsSnapshot(license), after)) {
      // A refund issued again after one failed at the provider finds that refund's reversal in place.
      if (license && alreadyReversed(item.kind, license, before, note)) continue;
      out.mismatches.push({ licenseId, kind: item.kind });
      continue;
    }
    if (isTrialConversion(item.kind, before)) {
      // decisions.md Phase 6: refunding a trial that was upgraded to paid revokes the license.
      await tx.license.update({ where: { id: licenseId }, data: { status: LicenseStatus.REVOKED, revokedAt: at, revokedReason: note } });
      await tx.licenseEvent.create({ data: { licenseId, type: "revoked", actor: SYSTEM_EVENT_ACTOR, detail: note, createdAt: at } });
      out.revoked.push(licenseId);
      continue;
    }
    const updated = await tx.license.update({
      where: { id: licenseId },
      data: {
        planId: before.planId,
        status: before.status as LicenseStatus,
        expiresAt: before.expiresAt ? new Date(before.expiresAt) : null,
        updatesUntil: new Date(before.updatesUntil),
        deviceLimit: before.deviceLimit,
      },
    });
    await tx.licenseEvent.create({
      data: { licenseId, type: "terms_restored", actor: SYSTEM_EVENT_ACTOR, detail: `${KIND_LABELS[item.kind]} reversed \u00B7 ${note}`, createdAt: at },
    });
    if (updated.deviceLimit < license.deviceLimit) {
      await trimDevicesToLimit(tx, { licenseId, accountId: license.accountId, limit: updated.deviceLimit, at, actor: SYSTEM_EVENT_ACTOR });
    }
    out.restored.push(licenseId);
  }
  out.revoked.push(...(await revokeOrderLicenses(tx, orderId, { reason: note, actor: SYSTEM_EVENT_ACTOR, at })));
  return out;
}

/** The license already carries this item's reversal: an earlier refund of the order made it, then failed. */
function alreadyReversed(
  kind: ItemKind,
  license: { status: LicenseStatus; revokedReason: string | null } & Parameters<typeof termsSnapshot>[0],
  before: TermsSnapshotLike,
  note: string,
): boolean {
  if (isTrialConversion(kind, before)) return license.status === LicenseStatus.REVOKED && license.revokedReason === note;
  return termsMatch(termsSnapshot(license), before);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Payment received ... " REVIEW reason for changes a refund could not undo. */
export function reviewReason(mismatches: readonly Mismatch[]): string {
  const ids = [...new Set(mismatches.map((m) => m.licenseId))];
  return `Refunded, but ${plural(mismatches.length, "license change")} could not be reversed automatically (${ids.join(", ")} changed since this order). Check the license terms, then mark the order reviewed.`;
}

/** Members' in-app notice and the customer's "refund_issued" email, in the refund transaction. */
async function announceRefund(
  tx: Tx,
  order: { id: string; email: string; accountId: string | null; billing: unknown; placedBy: { name: string } | null },
  refund: { id: string; amountPaise: number; creditNoteNo: string | null },
  revoked: readonly string[],
  now: Date,
): Promise<void> {
  const amount = formatINR(refund.amountPaise, { exact: true });
  if (order.accountId) {
    const members = await tx.accountMember.findMany({ where: { accountId: order.accountId, status: "ACTIVE" }, select: { userId: true } });
    if (members.length > 0) {
      const licenses = revoked.length > 0 ? ` ${revoked.length === 1 ? "Its license was" : `Its ${plural(revoked.length, "license")} were`} revoked.` : "";
      await tx.notification.createMany({
        data: members.map((m) => ({
          userId: m.userId,
          kind: "billing",
          title: `Refund issued for ${order.id}`,
          body: `${amount} is on its way back to the original payment method.${refund.creditNoteNo ? ` Credit note ${refund.creditNoteNo}.` : ""}${licenses}`,
          href: `/orders/${encodeURIComponent(order.id)}`,
          createdAt: now,
        })),
      });
    }
  }
  const billingName = readBillingSnapshot(order.billing).name.trim() || order.placedBy?.name || null;
  await enqueueEmail(tx, {
    to: order.email,
    templateId: "refund_issued",
    vars: {
      customer_name: greetingName(billingName),
      order_id: order.id,
      order_url: `${getEnv().APP_URL}${orderStatusPath(order.id, signOrderToken(order.id, order.email, now))}`,
      amount,
      credit_note_number: refund.creditNoteNo ?? "",
      licenses: revoked.join(", "),
    },
    dedupeKey: `refund_issued:${refund.id}`,
  });
}

/** Issues a refund for an order. See the module comment for the flow and the errors. */
export async function issueOrderRefund(input: IssueRefundInput): Promise<RefundOutcome> {
  const { orderId, staff, actor, body } = input;
  const now = input.now ?? new Date();
  const exists = await defaultDb.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!exists) throw errors.notFound("Order");
  // Role, reason and typed id before anything else, so a bad request never reaches the provider.
  validateDestructive("orders.refund", { staff, input: body, confirmValue: orderId });
  let refundedAtProvider: string | null = null;

  const outcome = await runDestructive<RefundOutcome>(
    "orders.refund",
    {
      staff,
      actor,
      input: body,
      targetId: orderId,
      target: orderId,
      targetType: "order",
      action: (r) => (r.duplicate ? DUPLICATE_REFUND_ACTION : DESTRUCTIVE_AUDIT_ACTIONS["orders.refund"]),
      detail: (r) => r.auditDetail,
      transaction: TX_OPTIONS,
    },
    async (tx, { reason }) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: {
          placedBy: { select: { name: true } },
          payments: { include: { refunds: { select: { amountPaise: true, status: true } } } },
          items: { select: { id: true, kind: true, fulfilledAt: true, targetLicenseId: true, termsBefore: true, termsAfter: true } },
        },
      });
      const paying = pickPayingPayment(order.payments, order.paidAt, await fulfilledProviderOrderId(tx, orderId));
      const requested = body.paymentId ? order.payments.find((p) => p.id === body.paymentId) : undefined;
      if (body.paymentId && !requested) throw errors.validation({ paymentId: NOT_ORDER_PAYMENT_MESSAGE });
      // A captured payment other than the one that paid the order: refunded on its own (see the module comment).
      const duplicate = requested !== undefined && requested.id !== paying?.id;
      if (duplicate) {
        if (!DUPLICATE_REFUNDABLE.has(order.status)) throw errors.conflict("not_refundable", NOT_REFUNDABLE_MESSAGE);
      } else {
        if (order.status === OrderStatus.REFUNDED) throw errors.conflict("already_refunded", ALREADY_REFUNDED_MESSAGE);
        if (!isRefundableStatus(order.status)) throw errors.conflict("not_refundable", NOT_REFUNDABLE_MESSAGE);
      }
      const target = duplicate ? requested : paying;
      if (!target || !target.providerPaymentId || !isPaymentProviderKey(target.provider) || !CAPTURED_PAYMENT.has(target.status)) {
        throw errors.conflict("not_refundable", NO_CAPTURE_MESSAGE);
      }
      const before = refundedSoFar(target.refunds);
      const remaining = target.amountPaise - before;
      if (remaining <= 0) throw errors.conflict("already_refunded", duplicate ? DUPLICATE_REFUNDED_MESSAGE : ALREADY_REFUNDED_MESSAGE);
      const amountPaise = body.amountPaise ?? remaining;
      if (!Number.isSafeInteger(amountPaise) || amountPaise < 1 || amountPaise > remaining) {
        throw errors.validation({ amountPaise: `Enter an amount up to ${formatINR(remaining, { exact: true })}.` });
      }
      // Only a full refund of the paying payment reverses the order's effects.
      const full = !duplicate && before + amountPaise >= target.amountPaise;

      const provider = input.provider ?? getPaymentProvider(target.provider);
      const payment: PayingPayment = { ...target, providerPaymentId: target.providerPaymentId };
      const providerRefundId = await requestProviderRefund(provider, payment, amountPaise, before, orderId);
      refundedAtProvider = providerRefundId;

      // Allocated late (the per-FY counter row stays locked until commit), and only against a tax invoice; a duplicate
      // payment was never invoiced, so its refund has no credit note.
      const invoice = duplicate ? null : await tx.invoice.findUnique({ where: { orderId }, select: { id: true } });
      const creditNoteNo = invoice ? await nextCreditNoteNumber(tx, now, (await getSettings(tx)).tax.creditNotePrefix) : null;
      const refund = await tx.refund.create({
        data: {
          paymentId: target.id,
          providerRefundId,
          amountPaise,
          reason,
          createdById: staff.id,
          creditNoteNo,
          status: RefundStatus.PENDING,
          createdAt: now,
        },
      });
      const reversal = full ? await reverseOrderEffects(tx, orderId, order.items, now) : { revoked: [], restored: [], mismatches: [] };
      const review = reversal.mismatches.length > 0;
      let status: OrderStatus = order.status;
      if (review) {
        status = OrderStatus.REVIEW;
        await tx.order.update({ where: { id: orderId }, data: { status, failReason: reviewReason(reversal.mismatches) } });
      }
      await announceRefund(tx, order, { id: refund.id, amountPaise, creditNoteNo }, reversal.revoked, now);

      const parts = duplicate
        ? [
            `${formatINR(amountPaise, { exact: true })}${before + amountPaise >= target.amountPaise ? "" : " (partial)"}`,
            `duplicate payment ${target.providerPaymentId}`,
            "no credit note, licenses unchanged",
          ]
        : [
            `${formatINR(amountPaise, { exact: true })}${full ? "" : " (partial)"}`,
            creditNoteNo ? `credit note ${creditNoteNo}` : "no credit note (no tax invoice)",
            `${plural(reversal.revoked.length, "license")} revoked`,
          ];
      if (reversal.restored.length > 0) parts.push(`${plural(reversal.restored.length, "license change")} reversed`);
      if (review) parts.push(`order flagged for review (${reversal.mismatches.map((m) => m.licenseId).join(", ")})`);
      parts.push(`${provider.key} refund ${providerRefundId}`);
      return {
        refund: { id: refund.id, amountPaise, creditNoteNo, status: "pending" },
        revokedLicenseIds: reversal.revoked,
        reversedLicenseIds: reversal.restored,
        review,
        orderStatus: status.toLowerCase() as OrderStatusValue,
        duplicate,
        auditDetail: parts.join(" \u00B7 "),
        provider: provider.key,
        providerOrderId: target.providerOrderId,
        providerPaymentId: payment.providerPaymentId,
        providerRefundId,
      };
    },
  ).catch((error: unknown) => {
    // The provider accepted but the database did not: refund.processed then finds a refund the console did not record
    // (lib/payments/webhook.ts recordExternalRefund: recorded for a duplicate, the order flagged for review otherwise).
    if (refundedAtProvider !== null) {
      log.error("admin_refund_unrecorded", { orderId, providerRefundId: refundedAtProvider, reason: error instanceof Error ? error.name : "unknown" });
    }
    throw error;
  });

  kickEmailDispatch();
  if (outcome.provider === "mock" && mockDeliveryEnabled()) {
    scheduleMockWebhook(
      {
        type: "refund.processed",
        providerOrderId: outcome.providerOrderId,
        providerPaymentId: outcome.providerPaymentId,
        providerRefundId: outcome.providerRefundId,
        amountPaise: outcome.refund.amountPaise,
      },
      MOCK_REFUND_WEBHOOK_DELAY_MS,
    );
  }
  log.info("admin_refund_issued", { orderId, refundId: outcome.refund.id, review: outcome.review });
  return outcome;
}
