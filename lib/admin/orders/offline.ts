/**
 * Admin > Orders "Record a payment we've received" (POST /api/admin/orders/offline, payments.record_offline: Owner and
 * Finance; docs/admin-records-design.md B3; decisions.md "Admin records" D12, D13; docs/security.md "Offline payments").
 *
 * The ONE documented exception to "licenses are issued only by the verified payment webhook": staff record money that
 * reached the business outside the payment provider (cash, UPI, bank transfer, cheque, other). Guards:
 * - a reason (checked first), the received date within the last 180 IST days and not in the future, a reference for
 *   UPI, bank transfers and cheques;
 * - the amount must EQUAL the server's total for the order (priced exactly like checkout): no partial payments;
 * - idempotent by `requestId` (Order.staffRequestId @unique): a double submit returns the first order and stores
 *   nothing new, also when both requests race (the second one's failure, a unique violation or a limited coupon's last
 *   slot taken by the first, is answered as a replay);
 * - ONE transaction creates the order, an offline Payment (provider "offline", CAPTURED, providerOrderId
 *   "offline:<order id>", reference, receivedAt, recordedById), locks the order row and runs fulfilPaidOrder() from
 *   lib/payments/fulfilment.ts, the webhook's own code: licenses with sealed keys and terms snapshots, the tax invoice
 *   number (gap-free per FY), the coupon redemption, account activity, notifications and the outbox emails; then one
 *   staff audit row "Recorded offline payment" (no "Webhook processed" row).
 * A fulfilment error rolls everything back (no order, no invoice number used) and answers 409 `fulfilment_failed`:
 * unlike the webhook, no money was taken through us, so there is no REVIEW state. paidAt is the moment staff record
 * it (invoice numbers stay in date order and license terms start at delivery); the received date is stored apart.
 * Orders paid offline cannot be refunded in the console in this release (D20).
 */
import "server-only";
import { ItemKind, PaymentStatus } from "@/generated/prisma/client";
import { audit, requireReason } from "@/lib/audit";
import { orderCreateData } from "@/lib/checkout/create-order";
import { DocumentSeriesExhaustedError, nextOrderId } from "@/lib/counters";
import { startOfDayIST } from "@/lib/dates";
import { db as defaultDb, type Db } from "@/lib/db";
import { isTransientDatabaseError } from "@/lib/db-errors";
import { kickEmailDispatch } from "@/lib/email";
import { ApiError, errors } from "@/lib/http";
import { FulfilmentError } from "@/lib/licensing/fulfil";
import { LicenseTermsError } from "@/lib/licensing/terms";
import { log } from "@/lib/log";
import { billingSnapshot } from "@/lib/orders/billing";
import { fulfilPaidOrder } from "@/lib/payments/fulfilment";
import { offlineProviderOrderId, OFFLINE_PROVIDER } from "@/lib/payments/types";
import { fulfilmentErrorCode } from "@/lib/payments/webhook";
import { concurrentReplay, findStaffOrderReplay, holdCoupon, orderAccount, priceStaffOrder, type AdminOrderContext } from "./create";
import { OFFLINE_METHOD_LABELS } from "./model";
import { offlineAuditDetail, ORDER_RECORD_MESSAGES, receivedOnIssue } from "./records-model";
import type { OfflineOrderInput } from "./schemas";

export const RECORDED_OFFLINE_PAYMENT = "Recorded offline payment";
/** Fulfilment runs inside the order transaction; the lock waits like the webhook's. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

export type OfflineOrderResult = {
  orderId: string;
  status: "paid";
  invoiceNumber: string;
  licensesIssued: number;
  licensesUpdated: number;
  totalPaise: number;
  replayed: boolean;
};

function isFulfilmentError(error: unknown): boolean {
  return error instanceof FulfilmentError || error instanceof LicenseTermsError || error instanceof DocumentSeriesExhaustedError;
}

/** The stored result of an earlier submit of the same form. */
async function replayResult(client: Db, order: { id: string; totalPaise: number; invoiceNumber: string | null }): Promise<OfflineOrderResult> {
  const [issued, updated] = await Promise.all([
    client.orderItem.count({ where: { orderId: order.id, kind: ItemKind.NEW, issuedLicenseId: { not: null } } }),
    client.orderItem.count({ where: { orderId: order.id, kind: { not: ItemKind.NEW }, fulfilledAt: { not: null } } }),
  ]);
  return {
    orderId: order.id,
    status: "paid",
    invoiceNumber: order.invoiceNumber ?? "",
    licensesIssued: issued,
    licensesUpdated: updated,
    totalPaise: order.totalPaise,
    replayed: true,
  };
}

/**
 * POST /api/admin/orders/offline. 422 reason_required (first) / receivedOn / amountPaise / the checkout cart errors,
 * 404 Customer, 409 fulfilment_failed / duplicate_request, 503 try_again (a deadlock or lock timeout; nothing stored).
 */
export async function createOfflinePaidOrder(input: OfflineOrderInput, ctx: AdminOrderContext): Promise<OfflineOrderResult> {
  const client = ctx.client ?? defaultDb;
  const now = ctx.now ?? new Date();
  const reason = requireReason(input.reason);
  const dateIssue = receivedOnIssue(input.receivedOn, now);
  if (dateIssue) throw errors.validation({ receivedOn: dateIssue });
  const replay = await findStaffOrderReplay(client, input.requestId, ctx.staff.id, "offline");
  if (replay) return replayResult(client, replay);
  try {
    return await recordOfflineOrder(client, input, ctx, reason, now);
  } catch (error) {
    // A concurrent double submit of the same form: the first one committed, and this one failed on its unique
    // requestId, on the limited coupon slot the first one used (at pricing or under the coupon lock) or on the amount.
    // Answer with the first order instead of an error that invites recording the payment again.
    const again = await concurrentReplay(client, input.requestId, ctx.staff.id, "offline");
    if (again) return replayResult(client, again);
    throw error;
  }
}

/** Prices, then creates, pays and fulfils the order in one transaction (see the module comment). */
async function recordOfflineOrder(
  client: NonNullable<AdminOrderContext["client"]>,
  input: OfflineOrderInput,
  ctx: AdminOrderContext,
  reason: string,
  now: Date,
): Promise<OfflineOrderResult> {
  const account = await orderAccount(client, input.accountId);
  const billing = billingSnapshot(input.billing);
  const priced = await priceStaffOrder(client, { accountId: account.id, items: input.items, couponCode: input.couponCode, billing }, now);
  const q = priced.quote;
  if (input.amountPaise !== q.totalPaise) throw errors.validation({ amountPaise: ORDER_RECORD_MESSAGES.amountMismatch(q.totalPaise) });
  const couponCode = q.coupon?.ok ? q.coupon.code : null;
  const receivedAt = startOfDayIST(input.receivedOn);
  const orderId = await client.$transaction((tx) => nextOrderId(tx));

  let result: OfflineOrderResult;
  try {
    result = await client.$transaction(async (tx) => {
      await holdCoupon(tx, couponCode, now);
      await tx.order.create({
        data: orderCreateData({
          id: orderId,
          accountId: account.id,
          placedByUserId: null,
          billing,
          quote: q,
          couponCode,
          now,
          terms: null,
          staff: { createdByStaffId: ctx.staff.id, staffRequestId: input.requestId },
        }),
      });
      await tx.payment.create({
        data: {
          orderId,
          provider: OFFLINE_PROVIDER,
          providerOrderId: offlineProviderOrderId(orderId),
          providerPaymentId: null,
          method: OFFLINE_METHOD_LABELS[input.method],
          amountPaise: q.totalPaise,
          status: PaymentStatus.CAPTURED,
          createdAt: now,
          capturedAt: now,
          reference: input.reference,
          receivedAt,
          recordedById: ctx.staff.id,
        },
      });
      // The webhook's lock: fulfilment always runs with the order row held.
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { placedBy: { select: { name: true } } } });
      const fulfilled = await fulfilPaidOrder(tx, { order, paidAt: now, now });
      const licensesIssued = fulfilled.issued.length;
      const licensesUpdated = fulfilled.results.length - licensesIssued;
      await audit(tx, ctx.actor, {
        action: RECORDED_OFFLINE_PAYMENT,
        target: orderId,
        targetType: "order",
        targetId: orderId,
        reason,
        detail: offlineAuditDetail({
          method: input.method,
          reference: input.reference,
          totalPaise: q.totalPaise,
          receivedAt,
          invoiceNumber: fulfilled.invoiceNumber,
          issued: licensesIssued,
          updated: licensesUpdated,
          legalName: account.legalName,
        }),
      });
      return {
        orderId,
        status: "paid" as const,
        invoiceNumber: fulfilled.invoiceNumber,
        licensesIssued,
        licensesUpdated,
        totalPaise: q.totalPaise,
        replayed: false,
      };
    }, TX_OPTIONS);
  } catch (error) {
    if (isFulfilmentError(error)) {
      const code = fulfilmentErrorCode(error);
      log.warn("admin_offline_fulfilment_failed", { orderId, reason: code });
      throw new ApiError(409, "fulfilment_failed", ORDER_RECORD_MESSAGES.fulfilmentFailed(code), { details: { code } });
    }
    if (isTransientDatabaseError(error)) {
      // Lock wait timeout, deadlock or a lost connection: nothing was stored, the same form can be submitted again.
      log.warn("admin_offline_payment_retry", { orderId });
      throw new ApiError(503, "try_again", ORDER_RECORD_MESSAGES.tryAgain, { headers: { "Retry-After": "2" } });
    }
    throw error;
  }

  kickEmailDispatch();
  log.info("admin_offline_payment_recorded", {
    orderId,
    accountId: account.id,
    method: input.method,
    totalPaise: q.totalPaise,
    licensesIssued: result.licensesIssued,
  });
  return result;
}
