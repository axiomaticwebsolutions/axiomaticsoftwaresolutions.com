/**
 * Development helpers for the mock checkout (/dev/mock-checkout, /api/dev/mock-checkout and its /bank route): the
 * availability gate, the payment methods on offer, the payment attempt a checkout acts on, and delivery of signed mock
 * webhooks to the real webhook route (APP_URL/api/webhooks/payments/mock) a moment later, as a provider would.
 * Everything here refuses to run in production, and the mock provider itself is refused there by lib/env.ts. The mock is
 * env-only: Admin > Settings > Integrations can never select it.
 */
import "server-only";
import { OrderStatus, PaymentStatus, type Order, type Payment } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { getEnv, isProduction } from "@/lib/env";
import { resolvePayments } from "@/lib/integrations/resolver";
import { ApiError } from "@/lib/http";
import { log } from "@/lib/log";
import { buildMockWebhook, type MockWebhookInput } from "./mock";

export const MOCK_WEBHOOK_PATH = "/api/webhooks/payments/mock";
export const MOCK_CHECKOUT_METHODS = ["UPI", "Card", "Net banking"] as const;
export type MockCheckoutMethod = (typeof MOCK_CHECKOUT_METHODS)[number];
export const MOCK_CHECKOUT_OUTCOMES = ["success", "pending", "failed", "canceled"] as const;
export type MockCheckoutOutcome = (typeof MOCK_CHECKOUT_OUTCOMES)[number];
/** payment.captured follows a successful checkout or a confirmed bank decision after this long. */
export const MOCK_CAPTURE_DELAY_MS = 1_500;
/** payment.failed arrives before the checkout page has finished its 900 ms "Returning to Axiomatic…" pause. */
export const MOCK_FAILURE_DELAY_MS = 600;
const DELIVERY_TIMEOUT_MS = 15_000;

export const MOCK_LINK_INVALID_MESSAGE = "This payment link isn\u2019t valid. The order may already be paid or was not found.";

/**
 * True only in development/test while the effective payments configuration is the mock (lib/integrations/resolver.ts).
 * Pages call notFound() and routes answer 404 otherwise. Production answers false before touching the resolver.
 */
export async function mockCheckoutEnabled(): Promise<boolean> {
  if (isProduction()) return false;
  try {
    const payments = await resolvePayments();
    return payments.source !== "none" && payments.config.provider === "mock";
  } catch {
    return false;
  }
}

/** 404 unless mockCheckoutEnabled(). */
export async function assertMockCheckoutEnabled(): Promise<void> {
  if (!(await mockCheckoutEnabled())) throw new ApiError(404, "not_found", "Not found.");
}

/** The order's latest payment attempt when it belongs to the mock provider, else null. */
export async function latestMockPayment(orderId: string): Promise<Payment | null> {
  const latest = await db.payment.findFirst({ where: { orderId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return latest && latest.provider === "mock" ? latest : null;
}

/**
 * The attempt a checkout outcome applies to: the order must be in `orderStatus` and its latest attempt a mock
 * payment in `paymentStatus`. Otherwise 409 `not_payable` with the prototype's invalid-link copy.
 */
export async function requireMockAttempt(
  order: Pick<Order, "id" | "status">,
  orderStatus: OrderStatus,
  paymentStatus: PaymentStatus,
): Promise<Payment> {
  const payment = order.status === orderStatus ? await latestMockPayment(order.id) : null;
  if (!payment || payment.status !== paymentStatus) throw new ApiError(409, "not_payable", MOCK_LINK_INVALID_MESSAGE);
  return payment;
}

/** True when an open checkout can be shown for the order (AWAITING_PAYMENT with a fresh mock attempt). */
export async function isMockCheckoutOpen(order: Pick<Order, "id" | "status">): Promise<boolean> {
  if (order.status !== OrderStatus.AWAITING_PAYMENT) return false;
  const payment = await latestMockPayment(order.id);
  return payment?.status === PaymentStatus.CREATED;
}

/** The order page to return to, keeping the order link token when the checkout was opened with one. */
export function mockReturnPath(orderId: string, token: string | null | undefined): string {
  const path = `/orders/${encodeURIComponent(orderId)}`;
  return token ? `${path}?t=${encodeURIComponent(token)}` : path;
}

export type MockDeliveryOptions = { appUrl?: string; fetch?: typeof fetch };

/** Signs `event` like the mock provider and POSTs it to the webhook route. Logs ids and the result only. */
export async function deliverMockWebhook(
  event: MockWebhookInput,
  opts: MockDeliveryOptions = {},
): Promise<{ status: number; result: string | null }> {
  if (isProduction()) throw new Error("Mock webhooks are disabled in production.");
  const { rawBody, headers, event: full } = buildMockWebhook(event);
  const url = `${(opts.appUrl ?? getEnv().APP_URL).replace(/\/+$/, "")}${MOCK_WEBHOOK_PATH}`;
  const res = await (opts.fetch ?? fetch)(url, {
    method: "POST",
    headers,
    body: rawBody,
    cache: "no-store",
    signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
  });
  let result: string | null = null;
  try {
    const data = (await res.json()) as { result?: unknown } | null;
    result = typeof data?.result === "string" ? data.result : null;
  } catch {
    result = null;
  }
  log.info("mock_webhook_delivered", { eventId: full.id, type: full.type, status: res.status, result });
  return { status: res.status, result };
}

/** Waits before the second and third attempt when a delivery fails (no answer in time, or a 5xx), as a provider retries. */
export const MOCK_RETRY_DELAYS_MS = [5_000, 20_000] as const;

/**
 * Fire-and-forget delivery after `delayMs` (the dev server keeps running, like a provider). A delivery that gets no
 * answer (network error or the 15 s timeout, e.g. while the dev server recompiles the webhook route) or a 5xx is sent
 * again with the same event id after MOCK_RETRY_DELAYS_MS; the webhook route is idempotent per event and per order.
 */
export function scheduleMockWebhook(event: MockWebhookInput, delayMs: number, opts: MockDeliveryOptions = {}): void {
  if (isProduction()) return;
  const withId: MockWebhookInput = { ...event, id: event.id ?? buildMockWebhook(event).event.id };
  const retry = (attempt: number, reason: string): void => {
    const wait = MOCK_RETRY_DELAYS_MS[attempt];
    log.warn("mock_webhook_failed", { type: event.type, attempt: attempt + 1, reason, retrying: wait !== undefined });
    if (wait !== undefined) setTimeout(() => send(attempt + 1), wait);
  };
  const send = (attempt: number): void => {
    deliverMockWebhook(withId, opts).then(
      (res) => {
        if (res.status >= 500) retry(attempt, `status ${res.status}`);
      },
      (error: unknown) => retry(attempt, error instanceof Error ? error.name : "unknown"),
    );
  };
  setTimeout(() => send(0), Math.max(0, delayMs));
}
