/**
 * MockProvider: the PaymentProvider used by tests and local development (env validation refuses it in production).
 * It follows Razorpay's signature schemes so the webhook and return routes are exercised the same way:
 * return signature = hex HMAC-SHA256(PAYMENT_KEY_SECRET, "<providerOrderId>|<providerPaymentId>"),
 * webhook signature = hex HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, rawBody) in the `x-mock-signature` header.
 *
 * Payments live in an in-memory ledger (per process, kept on globalThis so dev hot reloads do not drop it).
 */
import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import { safeEqual } from "@/lib/auth/tokens";
import { getEnv } from "@/lib/env";
import {
  PAYMENT_EVENT_TYPES,
  PaymentProviderError,
  type CreateOrderInput,
  type CreateOrderResult,
  type NormalizedEvent,
  type NormalizedPayment,
  type NormalizedRefund,
  type PaymentProvider,
  type RefundInput,
  type RefundResult,
  type ReturnSignatureInput,
  type WebhookVerification,
} from "./types";

export const MOCK_SIGNATURE_HEADER = "x-mock-signature";
export const MOCK_CHECKOUT_PATH = "/dev/mock-checkout";
export const MOCK_DEFAULT_KEY_ID = "mock_key";
export const MOCK_DEFAULT_FAILURE = "Your bank declined the payment.";
/** Webhook bodies above this size are rejected before parsing. */
export const MOCK_MAX_WEBHOOK_BYTES = 64 * 1024;

export type MockProviderSecrets = { keyId?: string; keySecret?: string; webhookSecret?: string };

type LedgerPayment = NormalizedPayment & { refundedPaise: number };
type LedgerOrder = { providerOrderId: string; orderId: string; amountPaise: number; paymentIds: string[] };
type Ledger = { orders: Map<string, LedgerOrder>; payments: Map<string, LedgerPayment>; refunds?: Map<string, NormalizedRefund> };

const store = globalThis as unknown as { __axsMockPaymentLedger?: Ledger };

function ledger(): Ledger {
  store.__axsMockPaymentLedger ??= { orders: new Map(), payments: new Map() };
  return store.__axsMockPaymentLedger;
}

/** Refunds by provider refund id (created lazily: a ledger kept across a hot reload may predate it). */
function refunds(): Map<string, NormalizedRefund> {
  const l = ledger();
  l.refunds ??= new Map();
  return l.refunds;
}

/**
 * Test/dev helper: what fetchRefund() reports for a refund from now on (simulates a refund that failed at the bank).
 * A failed refund gave nothing back, so its amount is refundable again.
 */
export function mockSetRefundStatus(providerRefundId: string, status: NormalizedRefund["status"]): void {
  const refund = refunds().get(providerRefundId);
  if (!refund) throw new PaymentProviderError("not_found", "Refund not found", "mock");
  const payment = ledger().payments.get(refund.providerPaymentId);
  if (payment && (refund.status === "failed") !== (status === "failed")) {
    payment.refundedPaise += status === "failed" ? -refund.amountPaise : refund.amountPaise;
    payment.status = payment.refundedPaise >= payment.amountPaise ? "refunded" : "captured";
  }
  refund.status = status;
}

/** Empties the in-memory ledger (tests). */
export function resetMockLedger(): void {
  store.__axsMockPaymentLedger = { orders: new Map(), payments: new Map(), refunds: new Map() };
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(7).toString("hex")}`;
}

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

function isPositivePaise(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function assertPositivePaise(value: number, what: string): void {
  if (!isPositivePaise(value)) throw new PaymentProviderError("invalid_request", `${what} must be a positive integer of paise`, "mock");
}

function publicPayment(p: LedgerPayment): NormalizedPayment {
  const { refundedPaise: _refunded, ...rest } = p;
  return { ...rest };
}

function ensureOrder(providerOrderId: string, amountPaise: number): LedgerOrder {
  const orders = ledger().orders;
  let order = orders.get(providerOrderId);
  if (!order) {
    // Dev servers restart and lose the ledger; a checkout page for an older order still works.
    order = { providerOrderId, orderId: "", amountPaise, paymentIds: [] };
    orders.set(providerOrderId, order);
  }
  return order;
}

function recordPayment(providerOrderId: string, payment: Omit<LedgerPayment, "providerPaymentId" | "providerOrderId" | "currency" | "refundedPaise">): NormalizedPayment {
  if (providerOrderId.length === 0) throw new PaymentProviderError("invalid_request", "providerOrderId is required", "mock");
  assertPositivePaise(payment.amountPaise, "amountPaise");
  const order = ensureOrder(providerOrderId, payment.amountPaise);
  const full: LedgerPayment = { ...payment, providerPaymentId: randomId("pay_mock"), providerOrderId, currency: "INR", refundedPaise: 0 };
  ledger().payments.set(full.providerPaymentId, full);
  order.paymentIds.push(full.providerPaymentId);
  return publicPayment(full);
}

/** Test/dev helper: records a captured payment (the amount may differ from the order to simulate a mismatch). */
export function mockCapture(providerOrderId: string, amountPaise: number, method = "UPI"): NormalizedPayment {
  return recordPayment(providerOrderId, { status: "captured", amountPaise, method });
}

/** Test/dev helper: records a failed payment attempt. */
export function mockFail(
  providerOrderId: string,
  amountPaise: number,
  failureReason = MOCK_DEFAULT_FAILURE,
  method = "UPI",
): NormalizedPayment {
  return recordPayment(providerOrderId, { status: "failed", amountPaise, method, failureReason });
}

/**
 * Dev/test helper (Phase 6 admin refunds): puts a captured payment that the database knows back into this process's
 * ledger, which is lost when the dev server restarts and never held the seeded sample payments, so a local admin
 * refund reaches the same refund() checks. No-op when the ledger already has the payment.
 */
export function mockAdoptCapturedPayment(input: {
  providerOrderId: string;
  providerPaymentId: string;
  amountPaise: number;
  refundedPaise?: number;
  method?: string | null;
}): void {
  const { payments } = ledger();
  if (payments.has(input.providerPaymentId)) return;
  assertPositivePaise(input.amountPaise, "amountPaise");
  const order = ensureOrder(input.providerOrderId, input.amountPaise);
  const refundedPaise = Math.min(Math.max(0, input.refundedPaise ?? 0), input.amountPaise);
  payments.set(input.providerPaymentId, {
    providerPaymentId: input.providerPaymentId,
    providerOrderId: input.providerOrderId,
    status: refundedPaise === input.amountPaise ? "refunded" : "captured",
    amountPaise: input.amountPaise,
    currency: "INR",
    ...(input.method ? { method: input.method } : {}),
    refundedPaise,
  });
  order.paymentIds.push(input.providerPaymentId);
}

/** The return signature the hosted checkout would send back (Razorpay scheme). */
export function signMockReturn(providerOrderId: string, providerPaymentId: string, keySecret?: string): string {
  return hmacHex(keySecret ?? requireSecret(getEnv().PAYMENT_KEY_SECRET, "PAYMENT_KEY_SECRET"), `${providerOrderId}|${providerPaymentId}`);
}

/** Hex HMAC of an exact webhook body, as sent in the `x-mock-signature` header. */
export function signMockWebhook(rawBody: string, webhookSecret?: string): string {
  return hmacHex(webhookSecret ?? getEnv().PAYMENT_WEBHOOK_SECRET, rawBody);
}

export type MockWebhookInput = Omit<NormalizedEvent, "id" | "currency"> & { id?: string; currency?: "INR" };

/** Test/dev helper: a signed webhook delivery for `event` (a fresh `evt_mock_` id unless one is given). */
export function buildMockWebhook(
  event: MockWebhookInput,
  opts: { webhookSecret?: string } = {},
): { rawBody: string; headers: Headers; event: NormalizedEvent } {
  const full: NormalizedEvent = { ...event, id: event.id ?? randomId("evt_mock"), currency: event.currency ?? "INR" };
  const rawBody = JSON.stringify(full);
  const headers = new Headers({ "content-type": "application/json", [MOCK_SIGNATURE_HEADER]: signMockWebhook(rawBody, opts.webhookSecret) });
  return { rawBody, headers, event: full };
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new PaymentProviderError("not_configured", `${name} is required for the mock payment provider`, "mock");
  return value;
}

const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

const webhookEventSchema = z
  .strictObject({
    id: providerId,
    type: z.enum(PAYMENT_EVENT_TYPES),
    providerOrderId: providerId,
    providerPaymentId: providerId.optional(),
    providerRefundId: providerId.optional(),
    amountPaise: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("INR"),
    method: z.string().min(1).max(40).optional(),
    failureReason: z.string().min(1).max(300).optional(),
  })
  .refine((e) => e.providerPaymentId !== undefined, { path: ["providerPaymentId"], message: "is required" })
  .refine((e) => (e.type !== "refund.processed" && e.type !== "refund.failed") || e.providerRefundId !== undefined, {
    path: ["providerRefundId"],
    message: "is required for refund events",
  });

/** Parses and validates a mock webhook body whose signature has already been checked. */
function parseWebhookBody(rawBody: string): WebhookVerification {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "invalid_payload", signatureOk: true };
  }
  const type = typeof body === "object" && body !== null ? (body as { type?: unknown }).type : undefined;
  if (typeof type === "string" && !(PAYMENT_EVENT_TYPES as readonly string[]).includes(type)) {
    return { ok: false, reason: "unsupported_event", signatureOk: true };
  }
  const parsed = webhookEventSchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: "invalid_payload", signatureOk: true };
  return { ok: true, event: parsed.data };
}

/** Mock PaymentProvider. Secrets default to the env (PAYMENT_KEY_ID / PAYMENT_KEY_SECRET / PAYMENT_WEBHOOK_SECRET). */
export class MockProvider implements PaymentProvider {
  readonly key = "mock" as const;
  readonly keyId: string;
  readonly #keySecret: string;
  readonly #webhookSecret: string;

  constructor(secrets: MockProviderSecrets = {}) {
    const needsEnv = secrets.keySecret === undefined || secrets.webhookSecret === undefined || secrets.keyId === undefined;
    const env = needsEnv ? getEnv() : null;
    this.keyId = secrets.keyId ?? env?.PAYMENT_KEY_ID ?? MOCK_DEFAULT_KEY_ID;
    this.#keySecret = requireSecret(secrets.keySecret ?? env?.PAYMENT_KEY_SECRET, "PAYMENT_KEY_SECRET");
    this.#webhookSecret = requireSecret(secrets.webhookSecret ?? env?.PAYMENT_WEBHOOK_SECRET, "PAYMENT_WEBHOOK_SECRET");
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    assertPositivePaise(input.amountPaise, "amountPaise");
    if (typeof input.orderId !== "string" || input.orderId.length === 0) {
      throw new PaymentProviderError("invalid_request", "orderId is required", "mock");
    }
    // The customer's contact details are deliberately not kept in the ledger.
    const providerOrderId = randomId("order_mock");
    ledger().orders.set(providerOrderId, { providerOrderId, orderId: input.orderId, amountPaise: input.amountPaise, paymentIds: [] });
    const query = new URLSearchParams({ order: providerOrderId, amount: String(input.amountPaise) });
    return { providerOrderId, checkout: { url: `${MOCK_CHECKOUT_PATH}?${query.toString()}`, keyId: this.keyId } };
  }

  verifyReturnSignature(input: ReturnSignatureInput): boolean {
    const { providerOrderId, providerPaymentId, signature } = input;
    if (typeof providerOrderId !== "string" || typeof providerPaymentId !== "string" || typeof signature !== "string") return false;
    if (providerOrderId.length === 0 || providerPaymentId.length === 0 || signature.length === 0) return false;
    return safeEqual(signature, hmacHex(this.#keySecret, `${providerOrderId}|${providerPaymentId}`));
  }

  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification {
    const signature = headers.get(MOCK_SIGNATURE_HEADER);
    if (!signature) return { ok: false, reason: "missing_signature", signatureOk: false };
    if (typeof rawBody !== "string" || Buffer.byteLength(rawBody, "utf8") > MOCK_MAX_WEBHOOK_BYTES) {
      return { ok: false, reason: "invalid_payload", signatureOk: false };
    }
    if (!safeEqual(signature.trim(), hmacHex(this.#webhookSecret, rawBody))) {
      return { ok: false, reason: "invalid_signature", signatureOk: false };
    }
    return parseWebhookBody(rawBody);
  }

  async fetchPayment(providerPaymentId: string): Promise<NormalizedPayment> {
    const payment = ledger().payments.get(providerPaymentId);
    if (!payment) throw new PaymentProviderError("not_found", "Payment not found", "mock");
    return publicPayment(payment);
  }

  async fetchOrderPayments(providerOrderId: string): Promise<NormalizedPayment[]> {
    const { orders, payments } = ledger();
    const order = orders.get(providerOrderId);
    if (!order) return [];
    return order.paymentIds.flatMap((id) => {
      const p = payments.get(id);
      return p ? [publicPayment(p)] : [];
    });
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    assertPositivePaise(input.amountPaise, "amountPaise");
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw new PaymentProviderError("invalid_request", "A refund reason is required", "mock");
    }
    const payment = ledger().payments.get(input.providerPaymentId);
    if (!payment) throw new PaymentProviderError("not_found", "Payment not found", "mock");
    if (payment.status !== "captured") {
      throw new PaymentProviderError("invalid_request", `Cannot refund a ${payment.status} payment`, "mock");
    }
    if (payment.refundedPaise + input.amountPaise > payment.amountPaise) {
      throw new PaymentProviderError("invalid_request", "Refund exceeds the captured amount", "mock");
    }
    payment.refundedPaise += input.amountPaise;
    if (payment.refundedPaise === payment.amountPaise) payment.status = "refunded";
    const providerRefundId = randomId("rfnd_mock");
    // The mock settles refunds at once (its refund.processed webhook follows the admin action).
    refunds().set(providerRefundId, { providerRefundId, providerPaymentId: payment.providerPaymentId, status: "processed", amountPaise: input.amountPaise, currency: "INR" });
    return { providerRefundId };
  }

  async fetchRefund(providerRefundId: string): Promise<NormalizedRefund> {
    const refund = refunds().get(providerRefundId);
    if (!refund) throw new PaymentProviderError("not_found", "Refund not found", "mock");
    return { ...refund };
  }

  /** Test/dev helper: a webhook delivery signed with this provider's webhook secret. */
  buildWebhook(event: MockWebhookInput): { rawBody: string; headers: Headers; event: NormalizedEvent } {
    return buildMockWebhook(event, { webhookSecret: this.#webhookSecret });
  }

  /** Test/dev helper: the return signature for this provider's key secret. */
  signReturn(providerOrderId: string, providerPaymentId: string): string {
    return signMockReturn(providerOrderId, providerPaymentId, this.#keySecret);
  }
}
