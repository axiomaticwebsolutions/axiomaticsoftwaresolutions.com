/**
 * Admin > Orders "New order" (docs/admin-records-design.md B1, B2; decisions.md "Admin records" D10, D13):
 *
 * - quoteAdminOrder (POST /api/admin/orders/quote, orders.create; with `orderId` also orders.edit): the live quote of
 *   the form, priced exactly as checkout prices it (lib/checkout/quote.ts priceCart) for the account's Owner. Read only.
 * - createPaymentLinkOrder (POST /api/admin/orders, orders.create): an unpaid order built by checkout's own code
 *   (assertPricedCart, orderCreateData) with NO payment attempt and no provider call. The customer opens the pay-only
 *   order link (lib/orders/token.ts "p1": it never delivers the license key), accepts the terms and pays through the
 *   existing retry path, which creates the provider order at the order's current total; licenses come only from the
 *   verified payment webhook (rule unchanged).
 *
 * Both writes need a reason (checked first), lock and re-check a limited coupon like checkout, and are idempotent by
 * `requestId` (Order.staffRequestId @unique): a repeat by the same staff member returns the first order
 * (`replayed: true`; also when a concurrent repeat failed on the coupon slot or the unique requestId), another staff
 * member's repeat is 409 `duplicate_request`. One audit row per order.
 */
import "server-only";
import type { PrismaClient, StaffRole } from "@/generated/prisma/client";
import { audit, requireReason, type AuditActor } from "@/lib/audit";
import { accountPricingBuyer } from "@/lib/checkout/buyer";
import { couponAvailability, lockCoupon } from "@/lib/checkout/coupon-hold";
import { assertPricedCart, orderCreateData } from "@/lib/checkout/create-order";
import { priceCart, toQuoteDto, type PricedCart, type QuoteDto } from "@/lib/checkout/quote";
import { nextOrderId } from "@/lib/counters";
import { db as defaultDb, type Db, type Tx } from "@/lib/db";
import { enqueueEmail, kickEmailDispatch } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { ApiError, errors } from "@/lib/http";
import { log } from "@/lib/log";
import { formatINR } from "@/lib/money";
import { billingSnapshot, type BillingSnapshot } from "@/lib/orders/billing";
import { ORDER_TOKEN_TTL_MS } from "@/lib/orders/token";
import { orderPayUrl } from "@/lib/payments/fulfilment";
import { OFFLINE_PROVIDER } from "@/lib/payments/types";
import { ORDER_RECORD_MESSAGES, paymentLinkAllowed, paymentLinkAuditDetail } from "./records-model";
import type { OrderCreateInput, OrderQuoteInput } from "./schemas";

export type AdminOrderContext = {
  staff: { id: string; role: StaffRole };
  actor: AuditActor;
  now?: Date;
  client?: PrismaClient;
};

// ---------- B1. Quote ----------

/** POST /api/admin/orders/quote. 404 Customer / Order. */
export async function quoteAdminOrder(client: Db, input: OrderQuoteInput, now: Date): Promise<{ quote: QuoteDto }> {
  let accountId: string | null;
  let excludeOrderId: string | null = null;
  if (input.orderId) {
    const order = await client.order.findUnique({ where: { id: input.orderId }, select: { id: true, accountId: true } });
    if (!order) throw errors.notFound("Order");
    accountId = order.accountId;
    excludeOrderId = order.id;
  } else {
    const account = await client.businessAccount.findUnique({ where: { id: input.accountId ?? "" }, select: { id: true } });
    if (!account) throw errors.notFound("Customer");
    accountId = account.id;
  }
  const priced = await priceCart(
    client,
    { items: input.items, couponCode: input.couponCode, billingState: input.billingState, excludeOrderId },
    accountPricingBuyer(accountId),
    now,
  );
  return { quote: toQuoteDto(priced) };
}

// ---------- Shared by payment-link and offline orders ----------

export type StaffOrderReplay = {
  id: string;
  email: string;
  status: string;
  canceledByStaffAt: Date | null;
  totalPaise: number;
  createdByStaffId: string | null;
  invoiceNumber: string | null;
  offline: boolean;
};

/**
 * The order an earlier submit of `requestId` created, or null. 409 `duplicate_request` when another staff member used
 * it, or when it created the other kind of order (a payment link replayed as an offline payment, or the reverse).
 */
export async function findStaffOrderReplay(
  client: Db,
  requestId: string,
  staffId: string,
  kind: "link" | "offline",
): Promise<StaffOrderReplay | null> {
  const row = await client.order.findUnique({
    where: { staffRequestId: requestId },
    select: {
      id: true,
      email: true,
      status: true,
      canceledByStaffAt: true,
      totalPaise: true,
      createdByStaffId: true,
      invoice: { select: { number: true } },
      payments: { where: { provider: OFFLINE_PROVIDER }, select: { id: true }, take: 1 },
    },
  });
  if (!row) return null;
  const offline = row.payments.length > 0;
  if (row.createdByStaffId !== staffId || offline !== (kind === "offline")) {
    throw errors.conflict("duplicate_request", ORDER_RECORD_MESSAGES.duplicateRequest);
  }
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    canceledByStaffAt: row.canceledByStaffAt,
    totalPaise: row.totalPaise,
    createdByStaffId: row.createdByStaffId,
    invoiceNumber: row.invoice?.number ?? null,
    offline,
  };
}

/**
 * After a failed write: the order a concurrent submit of the same form (same requestId) created, or null. Used for any
 * error, not only the requestId unique violation: the first submit may have taken a limited coupon's last slot, so the
 * second failed on the coupon before reaching the insert. 409 duplicate_request still applies; a failed lookup is
 * ignored (the original error is rethrown by the caller).
 */
export async function concurrentReplay(client: Db, requestId: string, staffId: string, kind: "link" | "offline"): Promise<StaffOrderReplay | null> {
  try {
    return await findStaffOrderReplay(client, requestId, staffId, kind);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return null;
  }
}

/** The account an admin order is for (404 Customer). */
export async function orderAccount(client: Db, accountId: string): Promise<{ id: string; legalName: string }> {
  const account = await client.businessAccount.findUnique({ where: { id: accountId }, select: { id: true, legalName: true } });
  if (!account) throw errors.notFound("Customer");
  return account;
}

/**
 * Prices the order for the account's Owner (a guest without an account: NEW items only) and refuses it exactly as
 * checkout refuses a cart (422).
 */
export async function priceStaffOrder(
  client: Db,
  input: { accountId: string | null; items: OrderCreateInput["items"]; couponCode: string | null; billing: BillingSnapshot; excludeOrderId?: string | null },
  now: Date,
): Promise<PricedCart> {
  const priced = await priceCart(
    client,
    { items: input.items, couponCode: input.couponCode, billingState: input.billing.state, excludeOrderId: input.excludeOrderId ?? null },
    accountPricingBuyer(input.accountId),
    now,
  );
  assertPricedCart(priced);
  return priced;
}

/** Takes the coupon's slot like checkout: the row locked, then re-checked against held slots (422 on couponCode). */
export async function holdCoupon(tx: Tx, couponCode: string | null, now: Date, excludeOrderId: string | null = null): Promise<void> {
  if (!couponCode) return;
  await lockCoupon(tx, couponCode);
  const available = await couponAvailability(tx, couponCode, { now, excludeOrderId });
  if (!available.ok) throw errors.validation({ couponCode: available.message });
}

/**
 * Queues the "order_payment_link" email (outbox). The link is pay-only (orderPayUrl): it opens the order and "Pay now"
 * but never delivers the license key, so the copy staff see and the emailed copy are the same harmless link.
 */
export async function enqueuePaymentLinkEmail(
  tx: Tx,
  order: { id: string; email: string; totalPaise: number; billing: BillingSnapshot },
  url: string,
  dedupeKey: string,
): Promise<void> {
  await enqueueEmail(tx, {
    to: order.email,
    templateId: "order_payment_link",
    vars: {
      customer_name: greetingName(order.billing.name),
      order_id: order.id,
      order_url: url,
      total: formatINR(order.totalPaise, { exact: true }),
    },
    dedupeKey,
  });
}

// ---------- B2. Payment-link order ----------

export type PaymentLinkOrderResult = {
  orderId: string;
  status: "awaiting_payment";
  totalPaise: number;
  /** The order page with a pay-only token (30 days; never delivers the license key), shown once with a Copy button. */
  paymentUrl: string;
  paymentUrlExpiresAt: string;
  emailQueued: boolean;
  replayed: boolean;
};

function linkResult(order: { id: string; email: string; totalPaise: number }, now: Date, replayed: boolean): PaymentLinkOrderResult {
  return {
    orderId: order.id,
    status: "awaiting_payment",
    totalPaise: order.totalPaise,
    paymentUrl: orderPayUrl(order, now),
    paymentUrlExpiresAt: new Date(now.getTime() + ORDER_TOKEN_TTL_MS).toISOString(),
    emailQueued: true,
    replayed,
  };
}

/** A replayed payment-link submit answers with a link only while the order can still be paid (409 not_payable). */
function replayLink(replay: StaffOrderReplay, now: Date): PaymentLinkOrderResult {
  if (!paymentLinkAllowed(replay)) throw errors.conflict("not_payable", ORDER_RECORD_MESSAGES.notPayable, { status: replay.status });
  return linkResult(replay, now, true);
}

/**
 * POST /api/admin/orders. 422 reason_required (first) / cart_invalid / couponCode / items / zero_total, 404 Customer,
 * 409 duplicate_request / not_payable (a replay of an order that was paid or cancelled since). The order is
 * AWAITING_PAYMENT with no Payment row (D10); `placedByUserId` stays null (the owner did not place it; members see it
 * through the account).
 */
export async function createPaymentLinkOrder(input: OrderCreateInput, ctx: AdminOrderContext): Promise<PaymentLinkOrderResult> {
  const client = ctx.client ?? defaultDb;
  const now = ctx.now ?? new Date();
  const reason = requireReason(input.reason);
  const replay = await findStaffOrderReplay(client, input.requestId, ctx.staff.id, "link");
  if (replay) return replayLink(replay, now);
  try {
    return await createLinkOrder(client, input, ctx, reason, now);
  } catch (error) {
    // A concurrent submit of the same form committed first: answer with its order. Checked for any error, not only the
    // requestId unique violation: the first submit may have taken a limited coupon's last slot, so this one failed at
    // pricing or under the coupon lock.
    const again = await concurrentReplay(client, input.requestId, ctx.staff.id, "link");
    if (again) return replayLink(again, now);
    throw error;
  }
}

async function createLinkOrder(
  client: NonNullable<AdminOrderContext["client"]>,
  input: OrderCreateInput,
  ctx: AdminOrderContext,
  reason: string,
  now: Date,
): Promise<PaymentLinkOrderResult> {
  const account = await orderAccount(client, input.accountId);
  const billing = billingSnapshot(input.billing);
  const priced = await priceStaffOrder(client, { accountId: account.id, items: input.items, couponCode: input.couponCode, billing }, now);
  const q = priced.quote;
  const couponCode = q.coupon?.ok ? q.coupon.code : null;
  const orderId = await client.$transaction((tx) => nextOrderId(tx));
  const order = { id: orderId, email: billing.email, totalPaise: q.totalPaise, billing };

  await client.$transaction(async (tx) => {
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
    await enqueuePaymentLinkEmail(tx, order, orderPayUrl(order, now), `order_payment_link:${orderId}`);
    await audit(tx, ctx.actor, {
      action: "Created order",
      target: orderId,
      targetType: "order",
      targetId: orderId,
      reason,
      detail: paymentLinkAuditDetail({ totalPaise: q.totalPaise, items: q.lines.length, couponCode, legalName: account.legalName }),
    });
  });

  kickEmailDispatch();
  log.info("admin_order_created", { orderId, accountId: account.id, lines: q.lines.length, totalPaise: q.totalPaise, mode: "payment_link" });
  return linkResult(order, now, false);
}
