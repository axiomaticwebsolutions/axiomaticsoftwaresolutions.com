/**
 * "Correct billing" on a paid order (POST /api/admin/orders/:id/correct-billing, invoices.correct: Owner and Finance;
 * docs/admin-records-design.md B7; decisions.md "Admin records" D16, D17).
 *
 * Amounts and items never change on a paid order (a refund is the existing path). A billing correction (name, mobile,
 * business, address, city, PIN, GSTIN; never the state or the email) issues, in ONE transaction with the order row
 * locked:
 * 1. a credit note for the then-current invoice's full value, numbered from the shared credit note series (refund
 *    credit notes use it too, so the series stays gap-free);
 * 2. a new tax invoice with the corrected details, from the invoice series (the Invoice row is renumbered in place, so
 *    every reader of order.invoice sees the current invoice);
 * 3. an append-only InvoiceCorrection row linking both to the cancelled original (number, date, billing and seller);
 * 4. Order.billing updated, account activity and one audit row (field names only).
 * The license, the payment, paidAt, the email, the place of supply and every amount stay untouched. Refused: an order
 * that is not PAID, has no invoice or has a PENDING / PROCESSED refund (409 not_correctable); a changed state or email,
 * a GSTIN from another state (422); nothing changed (422 nothing_changed); a business state in Settings that differs
 * from the original invoice's seller state (which could change the GST split), or a business GSTIN that differs from the
 * one the original invoice was issued under (a credit note must come from the same registration): 409
 * seller_state_changed.
 */
import "server-only";
import { OrderStatus, RefundStatus } from "@/generated/prisma/client";
import { audit, requireReason } from "@/lib/audit";
import { getSettings } from "@/lib/config";
import { DocumentSeriesExhaustedError, nextCreditNoteNumber, nextInvoiceNumber } from "@/lib/counters";
import { db as defaultDb } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import { readSellerSnapshot } from "@/lib/invoice/model";
import { log } from "@/lib/log";
import { readBillingSnapshot } from "@/lib/orders/billing";
import { sellerSnapshot, STAFF_ORDER_ACTOR_NAME } from "@/lib/payments/fulfilment";
import { recordAccountActivity } from "@/lib/portal/activity";
import { normalizeGstin } from "@/lib/validation/gstin";
import type { AdminOrderContext } from "./create";
import { correctedBilling } from "./correction-rules";
import { getAdminOrderDetail } from "./detail";
import type { AdminOrderDetail } from "./model";
import { ORDER_RECORD_MESSAGES } from "./records-model";
import type { BillingCorrectionInput } from "./schemas";

export const CORRECTED_BILLING_ACTION = "Corrected billing details";
const OPEN_REFUNDS: RefundStatus[] = [RefundStatus.PENDING, RefundStatus.PROCESSED];

export type BillingCorrectionResult = {
  correction: { id: string; creditNoteNo: string; originalInvoiceNo: string; newInvoiceNo: string; issuedAt: string };
  order: AdminOrderDetail;
};

/** POST /api/admin/orders/:id/correct-billing (see the module comment for the rules and errors). */
export async function correctOrderBilling(orderId: string, input: BillingCorrectionInput, ctx: AdminOrderContext): Promise<BillingCorrectionResult> {
  const client = ctx.client ?? defaultDb;
  const now = ctx.now ?? new Date();
  const reason = requireReason(input.reason);
  const exists = await client.order.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!exists) throw errors.notFound("Order");

  let created: BillingCorrectionResult["correction"];
  try {
    created = await client.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { invoice: true, payments: { select: { refunds: { select: { status: true } } } } },
      });
      const openRefund = order.payments.some((p) => p.refunds.some((r) => OPEN_REFUNDS.includes(r.status)));
      const invoice = order.invoice;
      if (order.status !== OrderStatus.PAID || !invoice || openRefund) {
        throw errors.conflict("not_correctable", ORDER_RECORD_MESSAGES.notCorrectable, { status: order.status });
      }
      const stored = readBillingSnapshot(order.billing);
      const result = correctedBilling(stored, input.billing);
      if (!result.ok) throw errors.validation(result.fieldErrors);
      if (result.changedFields.length === 0) {
        throw new ApiError(422, "nothing_changed", ORDER_RECORD_MESSAGES.nothingChanged, {
          details: { fieldErrors: {}, formErrors: [ORDER_RECORD_MESSAGES.nothingChanged] },
        });
      }
      const settings = await getSettings(tx);
      // The credit note must come from the registration that issued the invoice it cancels, and the GST split must not
      // move: the seller state AND GSTIN in Settings must still be the original invoice's.
      const original = readSellerSnapshot(invoice.seller);
      if (original.state !== settings.business.state || normalizeGstin(original.gstin) !== normalizeGstin(settings.business.gstin)) {
        throw errors.conflict("seller_state_changed", ORDER_RECORD_MESSAGES.sellerStateChanged);
      }
      // Allocated late in the transaction: both counter rows stay locked until commit (gap-free series).
      const creditNoteNo = await nextCreditNoteNumber(tx, now, settings.tax.creditNotePrefix);
      const newInvoiceNo = await nextInvoiceNumber(tx, now, settings.tax.invoicePrefix);
      const seller = sellerSnapshot(settings.business);
      const correction = await tx.invoiceCorrection.create({
        data: {
          orderId,
          creditNoteNo,
          originalInvoiceNo: invoice.number,
          originalIssuedAt: invoice.issuedAt,
          originalBilling: order.billing ?? {},
          originalSeller: invoice.seller ?? {},
          newInvoiceNo,
          billing: result.billing,
          seller,
          sac: invoice.sac,
          taxablePaise: order.taxablePaise,
          cgstPaise: order.cgstPaise,
          sgstPaise: order.sgstPaise,
          igstPaise: order.igstPaise,
          totalPaise: order.totalPaise,
          changedFields: result.changedFields,
          reason,
          createdById: ctx.staff.id,
          issuedAt: now,
          createdAt: now,
        },
      });
      await tx.invoice.update({ where: { orderId }, data: { number: newInvoiceNo, issuedAt: now, seller, pdfKey: null } });
      await tx.order.update({ where: { id: orderId }, data: { billing: result.billing } });
      if (order.accountId) {
        await recordAccountActivity(tx, {
          accountId: order.accountId,
          actor: { id: null, name: STAFF_ORDER_ACTOR_NAME },
          action: "Corrected invoice",
          target: newInvoiceNo,
          kind: "billing",
          at: now,
        });
      }
      await audit(tx, ctx.actor, {
        action: CORRECTED_BILLING_ACTION,
        target: orderId,
        targetType: "order",
        targetId: orderId,
        reason,
        detail: `Changed: ${result.changedFields.join(", ")} · Credit note ${creditNoteNo} cancels ${invoice.number} · New invoice ${newInvoiceNo}`,
      });
      return { id: correction.id, creditNoteNo, originalInvoiceNo: invoice.number, newInvoiceNo, issuedAt: now.toISOString() };
    });
  } catch (error) {
    if (error instanceof DocumentSeriesExhaustedError) {
      throw new ApiError(409, "invoice_series_exhausted", "The invoice or credit note series for this financial year is full. Change the prefix in Settings.");
    }
    throw error;
  }

  log.info("admin_billing_corrected", { orderId, creditNoteNo: created.creditNoteNo, newInvoiceNo: created.newInvoiceNo });
  return { correction: created, order: await getAdminOrderDetail(client, orderId, now) };
}
