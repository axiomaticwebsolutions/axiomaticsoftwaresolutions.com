/**
 * Payment attempts: the provider order for a checkout or a "Try again", and the payload the client needs to open the
 * provider's hosted checkout. The provider is always called OUTSIDE database transactions; the Payment row is then
 * inserted together with the order (create-order.ts) or with the status change (retryPayment), so an order never
 * exists without a payment attempt. A provider order whose transaction fails is simply never paid.
 */
import { ItemKind, LicenseStatus, OrderStatus, PaymentStatus, PublishStatus } from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/http";
import { log } from "@/lib/log";
import {
  getPaymentProvider,
  isPaymentProviderKey,
  PaymentProviderError,
  type CreateOrderResult,
  type PaymentProvider,
  type PaymentProviderKey,
} from "@/lib/payments";
import { readBillingSnapshot, type BillingSnapshot } from "@/lib/orders/billing";
import { assertCanActOnOrder, type OrderAccess } from "@/lib/orders/access";
import { orderStatusPath, signOrderToken } from "@/lib/orders/token";
import { SITE_NAME } from "@/lib/seo/metadata";
import type { Db } from "@/lib/db";
import { COUPON_HOLD_AWAITING_MS, couponAvailability, lockCoupon } from "./coupon-hold";

export const MOCK_CHECKOUT_PAGE = "/dev/mock-checkout";

export const PAYMENT_UNAVAILABLE_MESSAGE = "We couldn’t reach our payment partner. Please try again in a minute.";
export const NOT_RETRYABLE_MESSAGE = "This order can’t be paid again.";
export const ORDER_UNAVAILABLE_MESSAGE =
  "Something in this order can no longer be bought. Go back to your cart to start a new order.";

/** What the client opens: the dev mock checkout page, or Razorpay Checkout.js options. */
export type CheckoutPayload =
  | { kind: "mock"; url: string }
  | {
      kind: "razorpay";
      keyId: string;
      providerOrderId: string;
      amountPaise: number;
      currency: "INR";
      name: string;
      description: string;
      prefill: { name: string; email: string; contact: string };
    };

/** The 201 body of order creation and retry. */
export type CheckoutStart = { orderId: string; orderToken: string; statusUrl: string; checkout: CheckoutPayload };

/** "/dev/mock-checkout?order=AX-10312&t=..." (development with PAYMENT_PROVIDER=mock only). */
export function mockCheckoutUrl(orderId: string, token: string): string {
  return `${MOCK_CHECKOUT_PAGE}?order=${encodeURIComponent(orderId)}&t=${encodeURIComponent(token)}`;
}

export type PayableOrder = { id: string; totalPaise: number; billing: BillingSnapshot };

/** Builds the client payload for a provider order. */
export function checkoutPayload(
  providerKey: PaymentProviderKey,
  providerOrder: Pick<CreateOrderResult, "providerOrderId"> & { checkout?: Record<string, unknown> },
  order: PayableOrder,
  token: string,
): CheckoutPayload {
  switch (providerKey) {
    case "mock":
      return { kind: "mock", url: mockCheckoutUrl(order.id, token) };
    case "razorpay": {
      const fromAdapter = providerOrder.checkout?.keyId;
      const keyId = typeof fromAdapter === "string" && fromAdapter !== "" ? fromAdapter : (getEnv().PAYMENT_KEY_ID ?? "");
      if (keyId === "") throw new PaymentProviderError("not_configured", "PAYMENT_KEY_ID is required for Razorpay", "razorpay");
      return {
        kind: "razorpay",
        keyId,
        providerOrderId: providerOrder.providerOrderId,
        amountPaise: order.totalPaise,
        currency: "INR",
        name: SITE_NAME,
        description: `Order ${order.id}`,
        prefill: { name: order.billing.name, email: order.billing.email, contact: order.billing.phone },
      };
    }
    case "cashfree":
      throw new PaymentProviderError("not_configured", "Cashfree checkout is not supported", "cashfree");
  }
}

/** Calls the provider (never inside a transaction). Provider failures become 502 `payment_unavailable`. */
export async function createProviderOrder(
  provider: PaymentProvider,
  order: { id: string; totalPaise: number; email: string; phone?: string | null },
): Promise<CreateOrderResult> {
  try {
    return await provider.createOrder({
      orderId: order.id,
      amountPaise: order.totalPaise,
      customer: { email: order.email, ...(order.phone ? { phone: order.phone } : {}) },
    });
  } catch (error) {
    const errorCode = error instanceof PaymentProviderError ? error.code : "unexpected";
    log.error("payment_provider_create_failed", { orderId: order.id, provider: provider.key, errorCode, error });
    throw new ApiError(502, "payment_unavailable", PAYMENT_UNAVAILABLE_MESSAGE, { details: { orderId: order.id } });
  }
}

/** The 201 body for a provider order: a fresh order link token, the order page URL and the client payload. */
export function checkoutStart(
  order: PayableOrder,
  providerKey: PaymentProviderKey,
  providerOrder: Parameters<typeof checkoutPayload>[1],
  email: string,
  now: Date,
): CheckoutStart {
  const token = signOrderToken(order.id, email, now);
  return {
    orderId: order.id,
    orderToken: token,
    statusUrl: orderStatusPath(order.id, token),
    checkout: checkoutPayload(providerKey, providerOrder, order, token),
  };
}

/**
 * Retries must not sell what checkout would refuse today: NEW items need a live plan of a PUBLISHED product, and
 * items for existing licenses need the license to still belong to the order's account and not be revoked.
 */
export async function assertOrderStillPurchasable(db: PrismaClient, orderId: string, accountId: string | null): Promise<void> {
  const items = await db.orderItem.findMany({
    where: { orderId },
    select: { kind: true, targetLicenseId: true, plan: { select: { archived: true, product: { select: { status: true } } } } },
  });
  const targetIds = items.map((i) => i.targetLicenseId).filter((id): id is string => typeof id === "string");
  const licenses =
    targetIds.length > 0
      ? await db.license.findMany({ where: { id: { in: targetIds } }, select: { id: true, accountId: true, status: true } })
      : [];
  const byId = new Map(licenses.map((l) => [l.id, l]));
  const unavailable = () => new ApiError(409, "order_unavailable", ORDER_UNAVAILABLE_MESSAGE);
  for (const item of items) {
    const productStatus = item.plan.product.status;
    if (item.kind === ItemKind.NEW) {
      if (item.plan.archived || productStatus !== PublishStatus.PUBLISHED) throw unavailable();
      continue;
    }
    if (productStatus === PublishStatus.DRAFT) throw unavailable();
    const license = item.targetLicenseId ? byId.get(item.targetLicenseId) : undefined;
    if (!license || accountId === null || license.accountId !== accountId || license.status === LicenseStatus.REVOKED) {
      throw unavailable();
    }
  }
}

const RETRYABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([OrderStatus.FAILED, OrderStatus.CANCELED]);

function notRetryable(status: OrderStatus): ApiError {
  return new ApiError(409, "not_retryable", NOT_RETRYABLE_MESSAGE, { details: { status } });
}

/** Attempts whose payment succeeded or is being confirmed: the order must not be paid a second time. */
const SETTLING_ATTEMPT: PaymentStatus[] = [PaymentStatus.AUTHORIZED, PaymentStatus.CAPTURED];

async function assertNothingSettling(client: Db, orderId: string, status: OrderStatus): Promise<void> {
  const settling = await client.payment.count({ where: { orderId, status: { in: SETTLING_ATTEMPT } } });
  if (settling > 0) throw notRetryable(status);
}

/** A new attempt sells at the order's coupon price only while the coupon can still be used (lib/checkout/coupon-hold). */
async function assertCouponStillUsable(client: Db, order: { id: string; couponCode: string | null }, now: Date): Promise<void> {
  if (!order.couponCode) return;
  const available = await couponAvailability(client, order.couponCode, { now, excludeOrderId: order.id });
  if (available.ok) return;
  log.info("payment_retry_coupon_unavailable", { orderId: order.id, reason: available.reason });
  throw new ApiError(409, "order_unavailable", ORDER_UNAVAILABLE_MESSAGE);
}

/**
 * "Try again" / "Return to payment" (decisions.md Phase 3): FAILED or CANCELED -> AWAITING_PAYMENT with a new
 * Payment(CREATED) for the same order and amount. An AWAITING_PAYMENT order whose latest attempt is still CREATED
 * reopens that attempt instead of creating another provider order, unless the order has a coupon and that attempt is
 * older than the coupon hold (then it gets a fresh attempt, which re-checks the coupon). Anything else, and any order
 * with an AUTHORIZED or CAPTURED attempt (a payment is being confirmed), is 409 `not_retryable`; a new attempt whose
 * coupon is paused, outside its dates or used up is 409 `order_unavailable`.
 */
export async function retryPayment(
  db: PrismaClient,
  access: OrderAccess,
  opts: { now?: Date; provider?: PaymentProvider } = {},
): Promise<CheckoutStart> {
  assertCanActOnOrder(access);
  const now = opts.now ?? new Date();
  const order = access.order;
  const billing = readBillingSnapshot(order.billing);
  const payable: PayableOrder = { id: order.id, totalPaise: order.totalPaise, billing };

  if (order.status !== OrderStatus.AWAITING_PAYMENT && !RETRYABLE.has(order.status)) throw notRetryable(order.status);
  await assertNothingSettling(db, order.id, order.status);
  if (order.status === OrderStatus.AWAITING_PAYMENT) {
    const latest = await db.payment.findFirst({ where: { orderId: order.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const holdLapsed = order.couponCode !== null && latest !== null && now.getTime() - latest.createdAt.getTime() > COUPON_HOLD_AWAITING_MS;
    if (latest && latest.status === PaymentStatus.CREATED && isPaymentProviderKey(latest.provider) && !holdLapsed) {
      return checkoutStart(payable, latest.provider, { providerOrderId: latest.providerOrderId }, order.email, now);
    }
  }

  await assertOrderStillPurchasable(db, order.id, order.accountId);
  await assertCouponStillUsable(db, order, now);
  const provider = opts.provider ?? getPaymentProvider();
  const providerOrder = await createProviderOrder(provider, {
    id: order.id,
    totalPaise: order.totalPaise,
    email: order.email,
    phone: billing.phone,
  });

  await db.$transaction(async (tx) => {
    // Same lock as the webhook handler, so a late payment.captured and a retry never interleave.
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE`;
    const current = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } });
    if (!RETRYABLE.has(current.status) && current.status !== OrderStatus.AWAITING_PAYMENT) throw notRetryable(current.status);
    await assertNothingSettling(tx, order.id, current.status);
    if (order.couponCode) {
      // Same lock order as the webhook (order, then coupon); concurrent checkouts queue on the coupon row.
      await lockCoupon(tx, order.couponCode);
      await assertCouponStillUsable(tx, order, now);
    }
    await tx.payment.create({
      data: {
        orderId: order.id,
        provider: provider.key,
        providerOrderId: providerOrder.providerOrderId,
        amountPaise: order.totalPaise,
        status: PaymentStatus.CREATED,
        createdAt: now,
      },
    });
    await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.AWAITING_PAYMENT, failReason: null } });
  });

  log.info("payment_attempt_created", { orderId: order.id, provider: provider.key, retry: true });
  return checkoutStart(payable, provider.key, providerOrder, order.email, now);
}

