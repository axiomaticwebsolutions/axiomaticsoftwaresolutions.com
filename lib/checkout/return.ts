/**
 * The browser's callback after the provider's hosted checkout (api-contracts section 3): verifies the provider's
 * return signature (constant time, inside the adapter) against the order's payment attempts, marks the matched attempt
 * AUTHORIZED and moves the order to CONFIRMING. It NEVER marks the order paid and never issues licenses: only the
 * verified webhook (or reconciliation) does that.
 *
 * The provider signs a return only for a successful payment, so a verified return also reopens FAILED and CANCELED
 * orders: one provider order can hold several payments (Razorpay lets the customer try again inside its checkout, and
 * the failure webhook of the first one often arrives before this return), and a UPI payment can complete after the
 * checkout was closed. Leaving such an order FAILED would offer "Try again" to a customer who has paid. A failure
 * notice still waiting in the outbox is withdrawn. Paid, refunded and REVIEW orders are returned unchanged.
 */
import { OrderStatus, PaymentStatus } from "@/generated/prisma/enums";
import type { Payment, PrismaClient } from "@/generated/prisma/client";
import { ApiError } from "@/lib/http";
import { log } from "@/lib/log";
import { activePaymentProviderOrNull, isPaymentProviderKey, type PaymentProvider, type PaymentProviderKey } from "@/lib/payments";
import { assertCanActOnOrder, type OrderAccess } from "@/lib/orders/access";

export const RETURN_SIGNATURE_MESSAGE =
  "We couldn’t verify this payment with our payment partner. If money left your account, we’ll confirm the order automatically.";

const CONFIRMABLE: ReadonlySet<OrderStatus> = new Set<OrderStatus>([
  OrderStatus.AWAITING_PAYMENT,
  OrderStatus.PENDING,
  OrderStatus.FAILED,
  OrderStatus.CANCELED,
]);
/** Attempt states a verified return upgrades to AUTHORIZED; captured and refunded attempts are never touched. */
const AUTHORIZABLE: ReadonlySet<PaymentStatus> = new Set<PaymentStatus>([
  PaymentStatus.CREATED,
  PaymentStatus.PENDING,
  PaymentStatus.FAILED,
  PaymentStatus.CANCELED,
]);

export type PaymentReturnInput = { providerPaymentId: string; providerSignature: string };

type AdapterFor = (key: PaymentProviderKey) => PaymentProvider | null;

function safeAdapter(adapterFor: AdapterFor, key: PaymentProviderKey): PaymentProvider | null {
  try {
    return adapterFor(key);
  } catch {
    return null; // an adapter that is not configured here cannot have signed anything
  }
}

/** The attempt the signature belongs to (newest first), or null. */
function matchAttempt(payments: readonly Payment[], input: PaymentReturnInput, adapterFor: AdapterFor): Payment | null {
  for (const payment of payments) {
    if (!isPaymentProviderKey(payment.provider)) continue;
    const adapter = safeAdapter(adapterFor, payment.provider);
    if (!adapter) continue;
    const ok = adapter.verifyReturnSignature({
      providerOrderId: payment.providerOrderId,
      providerPaymentId: input.providerPaymentId,
      signature: input.providerSignature,
    });
    if (ok) return payment;
  }
  return null;
}

/** Throws 400 `invalid_signature` when no attempt of the order matches the signature. */
export async function recordPaymentReturn(
  db: PrismaClient,
  access: OrderAccess,
  input: PaymentReturnInput,
  opts: { providerFor?: (key: PaymentProviderKey) => PaymentProvider } = {},
): Promise<{ status: OrderStatus }> {
  assertCanActOnOrder(access);
  const orderId = access.order.id;
  const payments = await db.payment.findMany({ where: { orderId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  // Only the active provider (its current keys) can verify a return. Attempts made with other keys fail here; the
  // webhook settles them when the account is the same.
  let adapterFor: AdapterFor;
  if (opts.providerFor) {
    adapterFor = opts.providerFor;
  } else {
    const active = await activePaymentProviderOrNull();
    adapterFor = (key) => (active && active.key === key ? active : null);
  }
  const attempt = matchAttempt(payments, input, adapterFor);
  if (!attempt) {
    log.warn("payment_return_rejected", { orderId, attempts: payments.length });
    throw new ApiError(400, "invalid_signature", RETURN_SIGNATURE_MESSAGE);
  }

  const outcome = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const current = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: attempt.id } });
    if (payment.providerPaymentId === null) {
      // Unique column: never steal a provider payment id another attempt already recorded.
      const clash = await tx.payment.findUnique({ where: { providerPaymentId: input.providerPaymentId }, select: { id: true } });
      if (!clash) await tx.payment.update({ where: { id: payment.id }, data: { providerPaymentId: input.providerPaymentId } });
    }
    if (AUTHORIZABLE.has(payment.status)) {
      await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.AUTHORIZED, failureReason: null } });
    }
    if (!CONFIRMABLE.has(current.status)) return { status: current.status, reopened: null };
    await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.CONFIRMING, failReason: null } });
    // A "payment failed" notice that has not gone out yet is now wrong (the webhook handler does the same on PAID).
    await tx.outboxEmail.deleteMany({
      where: { status: "PENDING", templateId: "payment_failed", dedupeKey: { startsWith: `payment_failed:${orderId}:` } },
    });
    const reopened = current.status === OrderStatus.FAILED || current.status === OrderStatus.CANCELED ? current.status : null;
    return { status: OrderStatus.CONFIRMING, reopened };
  });

  if (outcome.reopened) log.info("payment_return_reopened_order", { orderId, from: outcome.reopened, paymentId: attempt.id });
  log.info("payment_return_recorded", { orderId, status: outcome.status, provider: attempt.provider });
  return { status: outcome.status };
}
