/**
 * Changes to unpaid orders in Admin > Orders (docs/admin-records-design.md B4-B6; decisions.md "Admin records" D14, D15):
 *
 * - updateUnpaidOrder (PATCH /api/admin/orders/:id, orders.edit): items, coupon and billing of an AWAITING_PAYMENT,
 *   FAILED or customer-CANCELED order. Re-priced with checkout's priceCart (its own coupon slot excluded), then in one
 *   transaction with the order row locked: the status re-checked (no payment settling), the lines replaced, the totals,
 *   coupon, billing, email and place of supply updated, every open (CREATED) attempt CANCELED and every open, cancelled
 *   or failed attempt stamped `supersededAt`. A Razorpay order cannot be withdrawn, so these are the backstops: the next
 *   "Pay now" creates a fresh provider order at the new total (retry reopens only an attempt whose amount equals the
 *   total), and a late capture of a stamped attempt sends the order to REVIEW (lib/payments/webhook.ts).
 * - cancelUnpaidOrder (POST /api/admin/orders/:id/cancel, orders.edit, DESTRUCTIVE "orders.cancel"): CANCELED with
 *   `canceledByStaffAt`, so the customer cannot reopen it (retry refuses it). Idempotent.
 * - sharePaymentLink (POST /api/admin/orders/:id/payment-link, orders.create): a freshly signed pay-only link (it
 *   never delivers the license key, lib/orders/token.ts), optionally
 *   emailed; audited without a reason (D4).
 */
import "server-only";
import { OrderStatus, PaymentStatus, type ItemKind } from "@/generated/prisma/client";
import { DESTRUCTIVE_AUDIT_ACTIONS, runDestructive, type DestructiveInput } from "@/lib/admin/destructive";
import { audit, requireReason } from "@/lib/audit";
import { db as defaultDb, type Db, type Tx } from "@/lib/db";
import { kickEmailDispatch } from "@/lib/email";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import { formatINR } from "@/lib/money";
import { billingSnapshot, readBillingSnapshot, type BillingSnapshot } from "@/lib/orders/billing";
import { ORDER_TOKEN_TTL_MS } from "@/lib/orders/token";
import { orderPayUrl } from "@/lib/payments/fulfilment";
import type { QuoteLine } from "@/lib/pricing";
import { enqueuePaymentLinkEmail, holdCoupon, priceStaffOrder, type AdminOrderContext } from "./create";
import { getAdminOrderDetail } from "./detail";
import type { AdminOrderDetail } from "./model";
import { changedBillingFields, ORDER_RECORD_MESSAGES, orderEditAuditDetail, orderLockError, paymentLinkAllowed } from "./records-model";
import type { OrderPatchInput } from "./schemas";

/** Attempts a staff edit or cancel replaces: a late capture of any of them goes to REVIEW. */
const SUPERSEDABLE: PaymentStatus[] = [PaymentStatus.CREATED, PaymentStatus.CANCELED, PaymentStatus.FAILED];

async function lockOrderRow(tx: Tx, orderId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
  return rows.length > 0;
}

function lockConflict(order: Parameters<typeof orderLockError>[0], op: "edit" | "cancel"): void {
  const lock = orderLockError(order, op);
  if (lock) throw new ApiError(409, lock.code, lock.message, { details: { status: order.status } });
}

/** CREATED attempts -> CANCELED, and open / cancelled / failed attempts stamped superseded. Returns the closed count. */
async function supersedeAttempts(tx: Tx, orderId: string, now: Date): Promise<number> {
  const closed = await tx.payment.updateMany({ where: { orderId, status: PaymentStatus.CREATED }, data: { status: PaymentStatus.CANCELED } });
  await tx.payment.updateMany({ where: { orderId, supersededAt: null, status: { in: SUPERSEDABLE } }, data: { supersededAt: now } });
  return closed.count;
}

type StoredLine = {
  planId: string;
  kind: ItemKind;
  quantity: number;
  unitPricePaise: number;
  creditPaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxPaise: number;
  targetLicenseId: string | null;
};

function sameLines(stored: readonly StoredLine[], lines: readonly QuoteLine[]): boolean {
  if (stored.length !== lines.length) return false;
  return stored.every((s, i) => {
    const l = lines[i];
    return (
      l !== undefined &&
      s.planId === l.planId &&
      s.kind === l.kind &&
      s.quantity === l.qty &&
      s.unitPricePaise === l.unitPricePaise &&
      s.creditPaise === l.creditPaise &&
      s.discountPaise === l.discountPaise &&
      s.taxablePaise === l.taxablePaise &&
      s.taxPaise === l.taxPaise &&
      (s.targetLicenseId ?? null) === (l.targetLicenseId ?? null)
    );
  });
}

// ---------- B5. Edit an unpaid order ----------

export type UpdateUnpaidOrderResult = { order: AdminOrderDetail; changed: boolean; paymentUrl: string };

/**
 * PATCH /api/admin/orders/:id. 422 reason_required (first) and the checkout cart errors, 404, 409 not_editable /
 * payment_in_progress / order_canceled. Nothing different from what is stored: `changed: false`, nothing written.
 * The account never changes (cancel and create a new order to bill another customer).
 */
export async function updateUnpaidOrder(orderId: string, input: OrderPatchInput, ctx: AdminOrderContext): Promise<UpdateUnpaidOrderResult> {
  const client = ctx.client ?? defaultDb;
  const now = ctx.now ?? new Date();
  const reason = requireReason(input.reason);
  const order = await client.order.findUnique({
    where: { id: orderId },
    include: { items: { orderBy: { id: "asc" } }, payments: { select: { status: true } } },
  });
  if (!order) throw errors.notFound("Order");
  lockConflict(order, "edit");

  const items =
    input.items ??
    order.items.map((i) => ({ planId: i.planId, qty: i.quantity, kind: i.kind, targetLicenseId: i.targetLicenseId }));
  const couponCode = input.couponCode !== undefined ? input.couponCode : order.couponCode;
  const stored = readBillingSnapshot(order.billing);
  const billing: BillingSnapshot = input.billing ? billingSnapshot(input.billing) : stored;
  const priced = await priceStaffOrder(client, { accountId: order.accountId, items, couponCode, billing, excludeOrderId: order.id }, now);
  const q = priced.quote;
  const newCoupon = q.coupon?.ok ? q.coupon.code : null;

  const changed: string[] = [];
  if (!sameLines(order.items, q.lines)) changed.push("items");
  if (newCoupon !== order.couponCode) changed.push("coupon");
  const billingFields = changedBillingFields(stored, billing);
  if (billingFields.length > 0) changed.push("billing");
  const totalsChanged =
    order.subtotalPaise !== q.subtotalPaise ||
    order.discountPaise !== q.discountPaise ||
    order.taxablePaise !== q.taxablePaise ||
    order.cgstPaise !== q.cgstPaise ||
    order.sgstPaise !== q.sgstPaise ||
    order.igstPaise !== q.igstPaise ||
    order.totalPaise !== q.totalPaise;
  if (changed.length === 0 && totalsChanged) changed.push("totals");
  if (changed.length === 0) {
    return { order: await getAdminOrderDetail(client, orderId, now), changed: false, paymentUrl: orderPayUrl(order, now) };
  }

  const closed = await client.$transaction(async (tx) => {
    if (!(await lockOrderRow(tx, orderId))) throw errors.notFound("Order");
    const current = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, canceledByStaffAt: true, payments: { select: { status: true } } },
    });
    lockConflict(current, "edit");
    await holdCoupon(tx, newCoupon, now, orderId);
    await tx.orderItem.deleteMany({ where: { orderId } });
    await tx.orderItem.createMany({
      data: q.lines.map((line) => ({
        orderId,
        planId: line.planId,
        kind: line.kind,
        quantity: line.qty,
        unitPricePaise: line.unitPricePaise,
        creditPaise: line.creditPaise,
        discountPaise: line.discountPaise,
        taxablePaise: line.taxablePaise,
        taxPaise: line.taxPaise,
        targetLicenseId: line.targetLicenseId,
      })),
    });
    await tx.order.update({
      where: { id: orderId },
      data: {
        couponCode: newCoupon,
        billing,
        email: billing.email,
        placeOfSupply: billing.state,
        subtotalPaise: q.subtotalPaise,
        discountPaise: q.discountPaise,
        taxablePaise: q.taxablePaise,
        cgstPaise: q.cgstPaise,
        sgstPaise: q.sgstPaise,
        igstPaise: q.igstPaise,
        totalPaise: q.totalPaise,
        status: OrderStatus.AWAITING_PAYMENT,
        failReason: null,
      },
    });
    const count = await supersedeAttempts(tx, orderId, now);
    await audit(tx, ctx.actor, {
      action: "Updated order",
      target: orderId,
      targetType: "order",
      targetId: orderId,
      reason,
      detail: orderEditAuditDetail({
        changed: billingFields.length > 0 ? changed.map((c) => (c === "billing" ? `billing (${billingFields.join(", ")})` : c)) : changed,
        oldTotal: order.totalPaise,
        newTotal: q.totalPaise,
        closed: count,
      }),
    });
    return count;
  });

  log.info("admin_order_updated", { orderId, changed, totalPaise: q.totalPaise, attemptsClosed: closed });
  return {
    order: await getAdminOrderDetail(client, orderId, now),
    changed: true,
    // Freshly signed: a changed email invalidates links signed for the old one.
    paymentUrl: orderPayUrl({ id: orderId, email: billing.email }, now),
  };
}

// ---------- B6. Cancel an unpaid order ----------

export type CancelOrderResult = { status: "canceled"; changed: boolean };

/**
 * POST /api/admin/orders/:id/cancel. 422 reason (first, also for a paid order), 404, 409 not_cancelable /
 * payment_in_progress. Already cancelled by staff: `changed: false`, no new audit row.
 */
export async function cancelUnpaidOrder(orderId: string, ctx: AdminOrderContext & { input: DestructiveInput }): Promise<CancelOrderResult> {
  const now = ctx.now ?? new Date();
  const result = await runDestructive(
    "orders.cancel",
    {
      staff: ctx.staff,
      actor: ctx.actor,
      input: ctx.input,
      targetId: orderId,
      target: orderId,
      targetType: "order",
      selfAudited: true,
      client: ctx.client,
    },
    async (tx, { reason, actor }) => {
      if (!(await lockOrderRow(tx, orderId))) throw errors.notFound("Order");
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { status: true, canceledByStaffAt: true, totalPaise: true, payments: { select: { status: true } } },
      });
      if (order.canceledByStaffAt) return { status: "canceled" as const, changed: false };
      lockConflict(order, "cancel");
      const closed = await supersedeAttempts(tx, orderId, now);
      await tx.order.update({
        where: { id: orderId },
        data: { status: OrderStatus.CANCELED, canceledByStaffAt: now, failReason: ORDER_RECORD_MESSAGES.canceledReason },
      });
      await audit(tx, actor, {
        action: DESTRUCTIVE_AUDIT_ACTIONS["orders.cancel"],
        target: orderId,
        targetType: "order",
        targetId: orderId,
        reason,
        detail: `${formatINR(order.totalPaise, { exact: true })} · ${closed} payment ${closed === 1 ? "attempt" : "attempts"} closed · can’t be paid any more`,
      });
      return { status: "canceled" as const, changed: true };
    },
  );
  if (result.changed) log.info("admin_order_canceled", { orderId });
  return result;
}

// ---------- B4. Re-share a payment link ----------

export type PaymentLinkResult = { url: string; expiresAt: string; emailQueued: boolean };

/** POST /api/admin/orders/:id/payment-link. 404, 409 not_payable. Audited ("Copied" / "Emailed to …"), no reason. */
export async function sharePaymentLink(client: Db, orderId: string, input: { send?: boolean }, ctx: AdminOrderContext): Promise<PaymentLinkResult> {
  const now = ctx.now ?? new Date();
  const order = await client.order.findUnique({
    where: { id: orderId },
    select: { id: true, email: true, status: true, canceledByStaffAt: true, totalPaise: true, billing: true },
  });
  if (!order) throw errors.notFound("Order");
  if (!paymentLinkAllowed(order)) throw errors.conflict("not_payable", ORDER_RECORD_MESSAGES.notPayable, { status: order.status });
  const url = orderPayUrl(order, now);
  const send = input.send === true;
  await (ctx.client ?? defaultDb).$transaction(async (tx) => {
    if (send) {
      await enqueuePaymentLinkEmail(
        tx,
        { id: order.id, email: order.email, totalPaise: order.totalPaise, billing: readBillingSnapshot(order.billing) },
        url,
        `order_payment_link:${order.id}:${now.getTime()}`,
      );
    }
    await audit(tx, ctx.actor, {
      action: "Shared payment link",
      target: order.id,
      targetType: "order",
      targetId: order.id,
      detail: send ? `Emailed to ${order.email}` : "Copied",
    });
  });
  if (send) kickEmailDispatch();
  return { url, expiresAt: new Date(now.getTime() + ORDER_TOKEN_TTL_MS).toISOString(), emailQueued: send };
}
