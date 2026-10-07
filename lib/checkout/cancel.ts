/**
 * The buyer closed the provider's checkout without paying (decisions.md Phase 3): AWAITING_PAYMENT -> CANCELED, and
 * the open attempt (Payment CREATED) -> CANCELED. Any other status is left alone and returned as is, so repeated or
 * late calls are harmless (a payment already confirming or paid is never cancelled from the browser).
 */
import { OrderStatus, PaymentStatus } from "@/generated/prisma/enums";
import type { PrismaClient } from "@/generated/prisma/client";
import { log } from "@/lib/log";
import { assertCanActOnOrder, type OrderAccess } from "@/lib/orders/access";

export async function cancelOrderPayment(db: PrismaClient, access: OrderAccess): Promise<{ status: OrderStatus }> {
  assertCanActOnOrder(access);
  const orderId = access.order.id;
  const status = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${orderId} FOR UPDATE`;
    const current = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    if (current.status !== OrderStatus.AWAITING_PAYMENT) return current.status;
    await tx.payment.updateMany({ where: { orderId, status: PaymentStatus.CREATED }, data: { status: PaymentStatus.CANCELED } });
    await tx.order.update({ where: { id: orderId }, data: { status: OrderStatus.CANCELED } });
    return OrderStatus.CANCELED;
  });
  if (status === OrderStatus.CANCELED && access.order.status !== OrderStatus.CANCELED) log.info("order_payment_canceled", { orderId });
  return { status };
}
