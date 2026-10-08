/**
 * Fulfilment of a paid order, shared by the verified payment webhook (lib/payments/webhook.ts, onCaptured) and the one
 * documented exception to "licenses come only from the webhook": an offline payment Owner or Finance record in
 * Admin > Orders (lib/admin/orders/offline.ts; docs/decisions.md "Admin records", docs/security.md). Both run exactly
 * this code inside their own transaction, with the order row locked:
 *
 * Order PAID (paidAt), licenses (lib/licensing/fulfil.ts: keys sealed as HMAC + AES-GCM + last 4, terms snapshots,
 * OrderItem.fulfilledAt as the idempotency marker), the tax invoice number (allocated late from the per-FY counter, with
 * the seller snapshot), the coupon redemption, account activity, member notifications and the outbox emails
 * (order_confirmation and one license_issued per new license; never a full key).
 * The caller writes its own audit row and kicks the email dispatcher after the commit.
 */
import "server-only";
import { OrderStatus, type Order, type Prisma } from "@/generated/prisma/client";
import { getSettings, type BusinessSettings, type SiteSettings } from "@/lib/config";
import { nextInvoiceNumber } from "@/lib/counters";
import type { Tx } from "@/lib/db";
import { enqueueEmail } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { getEnv } from "@/lib/env";
import { fulfilOrderItems, type FulfilResult } from "@/lib/licensing/fulfil";
import { log } from "@/lib/log";
import { formatINR } from "@/lib/money";
import { orderStatusPath, signOrderPayToken, signOrderToken } from "@/lib/orders/token";

/** The order row fulfilment reads (the webhook and the offline payment load it with `placedBy`). */
export type PaidOrderRow = Order & { placedBy: { name: string } | null };
export type IssuedLicense = { id: string; keyLast4: string; productName: string };
export type FulfilPaidOrderResult = { invoiceNumber: string; results: FulfilResult[]; issued: IssuedLicense[] };

/** Actor of account activity rows for orders created by staff (the customer did not place them). */
export const STAFF_ORDER_ACTOR_NAME = "Axiomatic team";

/** Seller details as printed on the invoice; later settings edits never change a stored snapshot. */
export function sellerSnapshot(business: BusinessSettings): Prisma.InputJsonObject {
  const { legalName, gstin, address, city, state, pin, sample } = business;
  return { legalName, gstin, address, city, state, pin, sample };
}

/** The billing name of an order snapshot, or null. */
export function billingName(order: Pick<Order, "billing">): string | null {
  const billing = order.billing;
  if (billing && typeof billing === "object" && !Array.isArray(billing)) {
    const name = (billing as Record<string, unknown>).name;
    if (typeof name === "string" && name.trim() !== "") return name.trim();
  }
  return null;
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Absolute order page link with a fresh 30-day order token (guests open it from the email). */
export function orderUrl(order: Pick<Order, "id" | "email">, now: Date): string {
  return `${getEnv().APP_URL}${orderStatusPath(order.id, signOrderToken(order.id, order.email, now))}`;
}

/**
 * Absolute order page link with a fresh 30-day PAY-ONLY token (lib/orders/token.ts "p1"): the payment links staff copy
 * and share (Admin > Orders) and the order_payment_link email. It opens the order and "Pay now" but never delivers the
 * one-time license key; the customer gets that from the order_confirmation link (orderUrl, signed at payment).
 */
export function orderPayUrl(order: Pick<Order, "id" | "email">, now: Date): string {
  return `${getEnv().APP_URL}${orderStatusPath(order.id, signOrderPayToken(order.id, order.email, now))}`;
}

/**
 * Locks the order's coupon row first, before the license and invoice counters: the webhook, offline payments, retries
 * and unpaid-order edits then all take order -> coupon -> counters in the same order, so two fulfilments sharing a
 * coupon never deadlock (an offline payment already holds the row; locking again is a no-op).
 */
async function lockOrderCoupon(tx: Tx, couponCode: string | null): Promise<void> {
  if (!couponCode) return;
  await tx.$queryRaw`SELECT "code" FROM "Coupon" WHERE "code" = ${couponCode} FOR UPDATE`;
}

/** The order's tax invoice: the existing one, else a new number from the per-FY counter (allocated late). */
export async function ensureInvoice(tx: Tx, orderId: string, paidAt: Date, settings: SiteSettings): Promise<{ number: string }> {
  const existing = await tx.invoice.findUnique({ where: { orderId }, select: { number: true } });
  if (existing) return existing;
  // Allocated late: the per-FY counter row stays locked until commit.
  const number = await nextInvoiceNumber(tx, paidAt, settings.tax.invoicePrefix);
  return tx.invoice.create({
    data: { number, orderId, sac: settings.tax.sac, seller: sellerSnapshot(settings.business), issuedAt: paidAt },
    select: { number: true },
  });
}

/** CouponRedemption once per order and Coupon.redemptions + 1. An exhausted coupon never blocks a paid order. */
export async function redeemCoupon(tx: Tx, order: Pick<Order, "id" | "couponCode" | "accountId">): Promise<void> {
  const code = order.couponCode;
  if (!code) return;
  const coupon = await tx.coupon.findUnique({ where: { code }, select: { code: true } });
  if (!coupon) {
    log.warn("coupon_missing_at_payment", { orderId: order.id, coupon: code });
    return;
  }
  const created = await tx.couponRedemption.createMany({
    data: [{ couponCode: code, orderId: order.id, accountId: order.accountId }],
    skipDuplicates: true,
  });
  if (created.count === 0) return;
  const updated = await tx.coupon.update({
    where: { code },
    data: { redemptions: { increment: 1 } },
    select: { redemptions: true, maxRedemptions: true },
  });
  if (updated.maxRedemptions !== null && updated.redemptions > updated.maxRedemptions) {
    log.warn("coupon_redemptions_exceeded", {
      orderId: order.id,
      coupon: code,
      redemptions: updated.redemptions,
      maxRedemptions: updated.maxRedemptions,
    });
  }
}

/** The licenses fulfilment issued (id, last 4 and product name for the emails). */
export async function issuedLicenses(tx: Tx, results: FulfilResult[]): Promise<IssuedLicense[]> {
  const ids = results.filter((r) => r.action === "issued").map((r) => r.licenseId);
  if (ids.length === 0) return [];
  const rows = await tx.license.findMany({
    where: { id: { in: ids } },
    select: { id: true, keyLast4: true, product: { select: { name: true } } },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => ({ id: r.id, keyLast4: r.keyLast4, productName: r.product.name }));
}

/** Account activity, member notifications and the outbox emails of a paid order (same transaction). */
export async function announcePaidOrder(
  tx: Tx,
  input: { order: PaidOrderRow; now: Date; invoiceNumber: string; issued: IssuedLicense[] },
): Promise<void> {
  const { order, now, invoiceNumber, issued } = input;
  const customerName = billingName(order) ?? order.placedBy?.name ?? null;
  if (order.accountId) {
    // An order staff created was not placed by a member: the activity says so instead of naming the owner.
    const byStaff = order.createdByStaffId !== null;
    await tx.accountActivity.create({
      data: {
        accountId: order.accountId,
        actorId: byStaff ? null : (order.placedByUserId ?? null),
        actorName: byStaff ? STAFF_ORDER_ACTOR_NAME : (order.placedBy?.name ?? customerName ?? "Customer"),
        action: "Placed order",
        target: order.id,
        kind: "billing",
        createdAt: now,
      },
    });
    const members = await tx.accountMember.findMany({
      where: { accountId: order.accountId, status: "ACTIVE" },
      select: { userId: true },
    });
    const body =
      issued.length > 0
        ? `${issued.length === 1 ? "Your new license is" : `Your ${plural(issued.length, "new license")} are`} ready. Invoice ${invoiceNumber}.`
        : `Your licenses have been updated. Invoice ${invoiceNumber}.`;
    if (members.length > 0) {
      await tx.notification.createMany({
        data: members.map((m) => ({
          userId: m.userId,
          kind: "billing",
          title: `Payment confirmed for ${order.id}`,
          body,
          href: `/orders/${encodeURIComponent(order.id)}`,
          createdAt: now,
        })),
      });
    }
  }

  const url = orderUrl(order, now);
  const name = greetingName(customerName);
  await enqueueEmail(tx, {
    to: order.email,
    templateId: "order_confirmation",
    vars: {
      customer_name: name,
      order_id: order.id,
      order_url: url,
      total: formatINR(order.totalPaise, { exact: true }),
      invoice_number: invoiceNumber,
    },
    dedupeKey: `order_confirmation:${order.id}`,
  });
  for (const license of issued) {
    await enqueueEmail(tx, {
      to: order.email,
      templateId: "license_issued",
      vars: {
        customer_name: name,
        product_name: license.productName,
        order_id: order.id,
        order_url: url,
        key_last4: license.keyLast4,
      },
      dedupeKey: `license_issued:${license.id}`,
    });
  }
  // A failure notice for an earlier attempt that has not gone out yet is now wrong.
  await tx.outboxEmail.deleteMany({
    where: { status: "PENDING", templateId: "payment_failed", dedupeKey: { startsWith: `payment_failed:${order.id}:` } },
  });
}

/**
 * Marks a locked, unpaid order PAID and fulfils it: licenses (lib/licensing/fulfil.ts, keys sealed with HMAC +
 * AES-GCM + last4, terms snapshots), the tax invoice number (allocated late), the coupon redemption, account activity,
 * member notifications and the outbox emails. The caller holds the order row lock (SELECT ... FOR UPDATE) in `tx`
 * and writes its own audit row. Lock order: order, coupon, license counter, invoice counter. Throws FulfilmentError / LicenseTermsError / DocumentSeriesExhaustedError.
 */
export async function fulfilPaidOrder(tx: Tx, input: { order: PaidOrderRow; paidAt: Date; now: Date }): Promise<FulfilPaidOrderResult> {
  const { order, paidAt, now } = input;
  await lockOrderCoupon(tx, order.couponCode);
  await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.PAID, paidAt, failReason: null } });
  const results = await fulfilOrderItems(tx, { id: order.id, accountId: order.accountId, paidAt });
  const settings = await getSettings(tx);
  const invoice = await ensureInvoice(tx, order.id, paidAt, settings);
  await redeemCoupon(tx, order);
  const issued = await issuedLicenses(tx, results);
  await announcePaidOrder(tx, { order, now, invoiceNumber: invoice.number, issued });
  return { invoiceNumber: invoice.number, results, issued };
}
