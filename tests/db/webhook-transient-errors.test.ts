/**
 * Fulfilment failures caused by the database itself (lock wait timeouts, deadlocks, lost connections) must not send a
 * paid order to REVIEW: processPaymentEvent rethrows, nothing is recorded, and the provider's redelivery fulfils.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { FulfilmentError } from "@/lib/licensing/fulfil";
import type * as FulfilModule from "@/lib/licensing/fulfil";
import { getPaymentProvider } from "@/lib/payments";
import type { MockProvider } from "@/lib/payments/mock";
import { processPaymentEvent } from "@/lib/payments/webhook";
import { placeOrder, seedCatalog, uniq } from "./checkout-fixtures";

const inject = vi.hoisted(() => ({ error: null as unknown }));
vi.mock("@/lib/licensing/fulfil", async (importOriginal) => {
  const actual = await importOriginal<typeof FulfilModule>();
  return {
    ...actual,
    fulfilOrderItems: async (...args: Parameters<typeof actual.fulfilOrderItems>) => {
      const error = inject.error;
      if (error) {
        inject.error = null;
        throw error;
      }
      return actual.fulfilOrderItems(...args);
    },
  };
});

const mock = () => getPaymentProvider("mock") as MockProvider;
const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError(`injected ${code}`, { code, clientVersion: "test", ...(meta ? { meta } : {}) });

beforeAll(async () => {
  await seedCatalog();
});

async function capturedOrder() {
  const placed = await placeOrder(null, { email: `${uniq("tx")}@example.test` });
  const payment = await db.payment.findFirstOrThrow({ where: { orderId: placed.orderId } });
  const order = await db.order.findUniqueOrThrow({ where: { id: placed.orderId } });
  const event = mock().buildWebhook({
    type: "payment.captured",
    providerOrderId: payment.providerOrderId,
    providerPaymentId: `pay_tx_${uniq("p").replace(/-/g, "")}`,
    amountPaise: order.totalPaise,
  }).event;
  return { order, event };
}

describe("transient database errors during fulfilment", () => {
  const transient: Array<[string, unknown]> = [
    ["an expired interactive transaction (P2028)", known("P2028")],
    ["a deadlock (P2034)", known("P2034")],
    ["a raw query deadlock (P2010, SQLSTATE 40P01)", known("P2010", { driverAdapterError: { cause: { kind: "postgres", originalCode: "40P01" } } })],
    ["a lost connection (P1017)", known("P1017")],
  ];
  it.each(transient)("%s: rethrown, nothing recorded, the order stays unpaid and the redelivery fulfils", async (_label, error) => {
    const { order, event } = await capturedOrder();
    inject.error = error;
    await expect(processPaymentEvent("mock", event)).rejects.toBe(error);
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect([after.status, after.failReason, after.paidAt]).toEqual(["AWAITING_PAYMENT", null, null]);
    expect(await db.webhookEvent.count({ where: { id: event.id } })).toBe(0);
    expect(await db.license.count({ where: { orderId: order.id } })).toBe(0);

    expect(await processPaymentEvent("mock", event)).toEqual({ status: 200, result: "fulfilled" });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await db.license.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("a problem with the order itself still goes to REVIEW (and a constraint violation is not transient)", async () => {
    for (const error of [new FulfilmentError("target_not_found", "item_injected", "injected"), known("P2002")]) {
      const { order, event } = await capturedOrder();
      inject.error = error;
      expect(await processPaymentEvent("mock", event)).toEqual({ status: 200, result: "fulfilment_failed" });
      expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REVIEW");
    }
  });
});
