/**
 * POST /api/dev/mock-checkout: the "Simulate the outcome" buttons of the dev mock checkout (/dev/mock-checkout), which
 * stands in for the provider's hosted page. Development only: 404 when NODE_ENV=production or PAYMENT_PROVIDER is not
 * "mock".
 *
 * Body (strict, 4 KB): `{ orderId, t?, outcome: "success" | "pending" | "failed" | "canceled", method: "UPI" | "Card" |
 * "Net banking" }`. CSRF double-submit token (session or "anon" binding) plus same-origin check. Access comes from the
 * session or the order link token `t` (lib/orders/access.ts; 401/403/404), and the viewer must be allowed to pay.
 * The order must be AWAITING_PAYMENT with a fresh mock attempt (Payment CREATED), else 409 `not_payable`.
 *
 * Outcomes (the browser then reports the return to the checkout API, as Checkout.js would, and opens `redirectTo`):
 * - success: a captured payment in the mock ledger; returns the signed `returnPayload` `{ providerPaymentId,
 *   providerSignature }` for POST /api/checkout/orders/:id/return, and a signed payment.captured webhook reaches
 *   /api/webhooks/payments/mock ~1.5 s later. Nothing here issues licenses.
 * - pending: the bank has not decided. Payment and order become PENDING; no webhook until POST
 *   /api/dev/mock-checkout/bank. No return payload (the provider reports no successful payment yet).
 * - failed: a failed payment in the ledger and a signed payment.failed webhook ~0.6 s later.
 * - canceled: nothing recorded; the browser calls POST /api/checkout/orders/:id/cancel.
 * Response: 200 `{ returnPayload?, redirectTo }` (the order page, keeping `?t=`). `Cache-Control: no-store`.
 */
import { z } from "zod";
import { OrderStatus, PaymentStatus } from "@/generated/prisma/client";
import { assertCsrf, csrfBinding } from "@/lib/auth/csrf";
import { getCurrentAuth } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ApiError, json, parseJsonBody, route } from "@/lib/http";
import { assertCanActOnOrder, resolveOrderAccess } from "@/lib/orders/access";
import { MOCK_DEFAULT_FAILURE, mockCapture, mockFail, signMockReturn } from "@/lib/payments/mock";
import {
  assertMockCheckoutEnabled,
  MOCK_CAPTURE_DELAY_MS,
  MOCK_CHECKOUT_METHODS,
  MOCK_CHECKOUT_OUTCOMES,
  MOCK_FAILURE_DELAY_MS,
  MOCK_LINK_INVALID_MESSAGE,
  mockReturnPath,
  requireMockAttempt,
  scheduleMockWebhook,
} from "@/lib/payments/mock-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({
  orderId: z.string().trim().min(1).max(40),
  t: z.string().trim().min(1).max(512).optional(),
  outcome: z.enum(MOCK_CHECKOUT_OUTCOMES),
  method: z.enum(MOCK_CHECKOUT_METHODS),
});

type MockCheckoutResponse = {
  returnPayload?: { providerPaymentId: string; providerSignature: string };
  redirectTo: string;
};

export const POST = route(async (req) => {
  await assertMockCheckoutEnabled();
  const env = getEnv();
  const auth = await getCurrentAuth();
  assertCsrf(req, { binding: csrfBinding(auth?.session.id), secret: env.CSRF_SECRET, appUrl: env.APP_URL });
  const body = await parseJsonBody(req, bodySchema, { maxBytes: 4 * 1024 });

  const access = await resolveOrderAccess(body.orderId, { token: body.t ?? null });
  assertCanActOnOrder(access);
  const { order } = access;
  const payment = await requireMockAttempt(order, OrderStatus.AWAITING_PAYMENT, PaymentStatus.CREATED);
  const redirectTo = mockReturnPath(order.id, body.t);
  const providerOrderId = payment.providerOrderId;

  switch (body.outcome) {
    case "success": {
      const paid = mockCapture(providerOrderId, order.totalPaise, body.method);
      scheduleMockWebhook(
        { type: "payment.captured", providerOrderId, providerPaymentId: paid.providerPaymentId, amountPaise: paid.amountPaise, method: body.method },
        MOCK_CAPTURE_DELAY_MS,
      );
      const returnPayload = {
        providerPaymentId: paid.providerPaymentId,
        providerSignature: signMockReturn(providerOrderId, paid.providerPaymentId),
      };
      return json<MockCheckoutResponse>({ returnPayload, redirectTo });
    }
    case "pending": {
      const moved = await db.$transaction(async (tx) => {
        const updated = await tx.order.updateMany({
          where: { id: order.id, status: OrderStatus.AWAITING_PAYMENT },
          data: { status: OrderStatus.PENDING },
        });
        if (updated.count !== 1) return false;
        await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.PENDING, method: body.method } });
        return true;
      });
      if (!moved) throw new ApiError(409, "not_payable", MOCK_LINK_INVALID_MESSAGE);
      return json<MockCheckoutResponse>({ redirectTo });
    }
    case "failed": {
      const failed = mockFail(providerOrderId, order.totalPaise, MOCK_DEFAULT_FAILURE, body.method);
      scheduleMockWebhook(
        {
          type: "payment.failed",
          providerOrderId,
          providerPaymentId: failed.providerPaymentId,
          amountPaise: failed.amountPaise,
          method: body.method,
          failureReason: MOCK_DEFAULT_FAILURE,
        },
        MOCK_FAILURE_DELAY_MS,
      );
      return json<MockCheckoutResponse>({ redirectTo });
    }
    case "canceled":
      return json<MockCheckoutResponse>({ redirectTo });
  }
});
