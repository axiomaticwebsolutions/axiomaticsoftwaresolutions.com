/**
 * POST /api/dev/mock-checkout/bank: the "simulate the bank's final answer" controls the order page shows for a PENDING
 * mock payment. Development only: 404 when NODE_ENV=production or PAYMENT_PROVIDER is not "mock".
 *
 * Body (strict, 4 KB): `{ orderId, t?, ok: boolean }`. CSRF double-submit token plus same-origin check; access from
 * the session or the order link token, and the viewer must be allowed to pay. The order must be PENDING with a PENDING
 * mock attempt, else 409 `not_payable`.
 * - ok: a captured payment in the mock ledger, order CONFIRMING (payment AUTHORIZED), and a signed payment.captured
 *   webhook ~1.5 s later, which pays and fulfils the order through the real webhook route.
 * - not ok: a failed payment in the ledger and a signed payment.failed webhook ~0.6 s later (order FAILED then).
 * Response: 200 `{ status, scheduled }` with the order status right after the call. `Cache-Control: no-store`.
 */
import { z } from "zod";
import { OrderStatus, PaymentStatus } from "@/generated/prisma/client";
import { assertCsrf, csrfBinding } from "@/lib/auth/csrf";
import { getCurrentAuth } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { json, parseJsonBody, route } from "@/lib/http";
import { assertCanActOnOrder, resolveOrderAccess } from "@/lib/orders/access";
import { MOCK_DEFAULT_FAILURE, mockCapture, mockFail } from "@/lib/payments/mock";
import {
  assertMockCheckoutEnabled,
  MOCK_CAPTURE_DELAY_MS,
  MOCK_FAILURE_DELAY_MS,
  requireMockAttempt,
  scheduleMockWebhook,
} from "@/lib/payments/mock-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({
  orderId: z.string().trim().min(1).max(40),
  t: z.string().trim().min(1).max(512).optional(),
  ok: z.boolean(),
});

export const POST = route(async (req) => {
  await assertMockCheckoutEnabled();
  const env = getEnv();
  const auth = await getCurrentAuth();
  assertCsrf(req, { binding: csrfBinding(auth?.session.id), secret: env.CSRF_SECRET, appUrl: env.APP_URL });
  const body = await parseJsonBody(req, bodySchema, { maxBytes: 4 * 1024 });

  const access = await resolveOrderAccess(body.orderId, { token: body.t ?? null });
  assertCanActOnOrder(access);
  const { order } = access;
  const payment = await requireMockAttempt(order, OrderStatus.PENDING, PaymentStatus.PENDING);
  const providerOrderId = payment.providerOrderId;
  const method = payment.method ?? "UPI";

  if (body.ok) {
    const paid = mockCapture(providerOrderId, order.totalPaise, method);
    const status = await db.$transaction(async (tx) => {
      const moved = await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PENDING },
        data: { status: OrderStatus.CONFIRMING },
      });
      if (moved.count !== 1) return (await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true } })).status;
      await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.AUTHORIZED } });
      return OrderStatus.CONFIRMING;
    });
    scheduleMockWebhook(
      { type: "payment.captured", providerOrderId, providerPaymentId: paid.providerPaymentId, amountPaise: paid.amountPaise, method },
      MOCK_CAPTURE_DELAY_MS,
    );
    return json({ status, scheduled: "payment.captured" });
  }

  const failed = mockFail(providerOrderId, order.totalPaise, MOCK_DEFAULT_FAILURE, method);
  scheduleMockWebhook(
    {
      type: "payment.failed",
      providerOrderId,
      providerPaymentId: failed.providerPaymentId,
      amountPaise: failed.amountPaise,
      method,
      failureReason: MOCK_DEFAULT_FAILURE,
    },
    MOCK_FAILURE_DELAY_MS,
  );
  return json({ status: order.status, scheduled: "payment.failed" });
});
