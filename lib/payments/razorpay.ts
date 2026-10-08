/**
 * Razorpay adapter: REST over fetch with HTTP Basic auth (key_id:key_secret) against https://api.razorpay.com/v1,
 * no SDK. The browser opens Checkout.js with the `checkout` payload from createOrder(); auto-capture is assumed, so a
 * successful payment arrives as `payment.captured` (and `order.paid`, which is mapped to the same semantics and then
 * answered `already_paid` by the webhook handler).
 *
 * Signatures, per Razorpay's documentation:
 * - checkout return: hex HMAC-SHA256(key_secret, "<razorpay_order_id>|<razorpay_payment_id>")
 * - webhooks: hex HMAC-SHA256(webhook_secret, exact raw body) in `X-Razorpay-Signature`; the event id, stable across
 *   retries, in `X-Razorpay-Event-Id`.
 * Both are compared in constant time. Secrets, request bodies and provider payloads are never logged, and payment
 * entities are parsed with schemas that drop every card, VPA, bank, wallet, email and phone field: only ids, amounts,
 * currency, status, a method label and the failure description leave this module.
 */
import { createHmac } from "node:crypto";
import { z } from "zod";
import { safeEqual } from "@/lib/auth/tokens";
import { log } from "@/lib/log";
import {
  PaymentProviderError,
  type CreateOrderInput,
  type CreateOrderResult,
  type NormalizedEvent,
  type NormalizedPayment,
  type NormalizedPaymentStatus,
  type NormalizedRefund,
  type PaymentProvider,
  type PaymentProviderErrorCode,
  type RefundInput,
  type RefundResult,
  type ReturnSignatureInput,
  type WebhookVerification,
} from "./types";

export const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";
export const RAZORPAY_SIGNATURE_HEADER = "x-razorpay-signature";
export const RAZORPAY_EVENT_ID_HEADER = "x-razorpay-event-id";
/** Razorpay webhook bodies are a few KB; anything above this is rejected before the HMAC is computed. */
export const RAZORPAY_MAX_WEBHOOK_BYTES = 256 * 1024;
export const RAZORPAY_DEFAULT_TIMEOUT_MS = 10_000;
/** Razorpay limits `receipt` to 40 characters and each `notes` value to 256. */
const RECEIPT_MAX = 40;
const NOTE_MAX = 256;
const FAILURE_REASON_MAX = 300;

/** Razorpay events this adapter normalizes; every other event is answered `unsupported_event`. */
export const RAZORPAY_SUPPORTED_EVENTS = ["payment.captured", "order.paid", "payment.failed", "refund.processed", "refund.failed"] as const;

const METHOD_LABELS: Readonly<Record<string, string>> = {
  upi: "UPI",
  card: "Card",
  netbanking: "Net banking",
  wallet: "Wallet",
  emi: "EMI",
  cardless_emi: "Cardless EMI",
  paylater: "Pay later",
  bank_transfer: "Bank transfer",
  emandate: "eMandate",
  nach: "NACH",
};

/** Display label for a Razorpay payment method ("upi" -> "UPI"); undefined when unknown. Never instrument details. */
export function razorpayMethodLabel(method: string | null | undefined): string | undefined {
  if (typeof method !== "string") return undefined;
  return METHOD_LABELS[method.toLowerCase()];
}

const STATUS_MAP: Readonly<Record<string, NormalizedPaymentStatus>> = {
  created: "created",
  authorized: "authorized",
  captured: "captured",
  refunded: "refunded",
  failed: "failed",
};

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const rzpId = z.string().regex(ID_RE);
const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const currency = z.string().regex(/^[A-Z]{3}$/);
const unixSeconds = z.number().int().positive();

// z.object() strips unknown keys, so card, vpa, bank, wallet, email, contact and notes never survive parsing.
const paymentEntity = z.object({
  id: rzpId,
  amount: paise,
  currency,
  status: z.string().max(40),
  order_id: rzpId.nullish(),
  method: z.string().max(40).nullish(),
  error_description: z.string().nullish(),
  created_at: unixSeconds.nullish(),
});
type PaymentEntity = z.output<typeof paymentEntity>;

const orderEntity = z.object({
  id: rzpId,
  amount: paise,
  currency,
  status: z.string().max(40).optional(),
});

const refundEntity = z.object({
  id: rzpId,
  amount: paise,
  currency,
  payment_id: rzpId,
  status: z.string().max(40).optional(),
});

const collection = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item).max(1000) });

const webhookEnvelope = z.object({
  event: z.string().min(1).max(100),
  created_at: unixSeconds.optional(),
  payload: z.object({
    payment: z.object({ entity: paymentEntity }).optional(),
    order: z.object({ entity: orderEntity }).optional(),
    refund: z.object({ entity: refundEntity }).optional(),
  }),
});

function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** Hex HMAC-SHA256 of the exact webhook body, as Razorpay sends it in X-Razorpay-Signature. */
export function signRazorpayWebhook(rawBody: string, webhookSecret: string): string {
  return hmacHex(webhookSecret, rawBody);
}

/** The checkout return signature: hex HMAC-SHA256(key_secret, "<order_id>|<payment_id>"). */
export function signRazorpayReturn(providerOrderId: string, providerPaymentId: string, keySecret: string): string {
  return hmacHex(keySecret, `${providerOrderId}|${providerPaymentId}`);
}

function failureReason(entity: PaymentEntity): string | undefined {
  const text = entity.error_description?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > FAILURE_REASON_MAX ? `${text.slice(0, FAILURE_REASON_MAX - 1)}…` : text;
}

/** A Razorpay payment entity as a NormalizedPayment (`fallbackOrderId` when the entity has no order_id). */
export function normalizeRazorpayPayment(entity: unknown, fallbackOrderId?: string): NormalizedPayment {
  const parsed = paymentEntity.safeParse(entity);
  if (!parsed.success) throw new PaymentProviderError("provider_error", "Unexpected payment entity from Razorpay", "razorpay");
  const p = parsed.data;
  const providerOrderId = p.order_id ?? fallbackOrderId;
  if (!providerOrderId) throw new PaymentProviderError("provider_error", "Razorpay payment has no order id", "razorpay");
  const out: NormalizedPayment = {
    providerPaymentId: p.id,
    providerOrderId,
    status: STATUS_MAP[p.status] ?? "created",
    amountPaise: p.amount,
    currency: p.currency,
  };
  const method = razorpayMethodLabel(p.method);
  if (method) out.method = method;
  const reason = p.status === "failed" ? failureReason(p) : undefined;
  if (reason) out.failureReason = reason;
  return out;
}

/** A Razorpay refund entity (status pending | processed | failed) as a NormalizedRefund. */
export function normalizeRazorpayRefund(entity: unknown): NormalizedRefund {
  const parsed = refundEntity.safeParse(entity);
  if (!parsed.success) throw new PaymentProviderError("provider_error", "Unexpected refund entity from Razorpay", "razorpay");
  const r = parsed.data;
  const status = r.status === "processed" ? "processed" : r.status === "failed" ? "failed" : "pending";
  return { providerRefundId: r.id, providerPaymentId: r.payment_id, status, amountPaise: r.amount, currency: r.currency };
}

const SUPPORTED_EVENTS: ReadonlySet<string> = new Set(RAZORPAY_SUPPORTED_EVENTS);
const INVALID: WebhookVerification = { ok: false, reason: "invalid_payload", signatureOk: true };
const UNSUPPORTED: WebhookVerification = { ok: false, reason: "unsupported_event", signatureOk: true };

function eventIdFor(header: string | null, event: string, entityId: string): string {
  const fromHeader = header?.trim();
  if (fromHeader && ID_RE.test(fromHeader)) return fromHeader;
  // Razorpay always sends the header; the fallback is still stable across retries of one event.
  return `${event}:${entityId}`;
}

function paymentEvent(
  type: "payment.captured" | "payment.failed",
  providerOrderId: string,
  payment: PaymentEntity,
  id: string,
  occurredAt: Date | undefined,
): NormalizedEvent {
  const event: NormalizedEvent = {
    id,
    type,
    providerOrderId,
    providerPaymentId: payment.id,
    amountPaise: payment.amount,
    currency: payment.currency,
  };
  const method = razorpayMethodLabel(payment.method);
  if (method) event.method = method;
  if (type === "payment.failed") {
    const reason = failureReason(payment);
    if (reason) event.failureReason = reason;
  }
  if (occurredAt) event.occurredAt = occurredAt;
  return event;
}

/**
 * Normalizes a signature-verified Razorpay webhook body (already JSON-parsed). `eventIdHeader` is the
 * X-Razorpay-Event-Id header. `order.paid` becomes `payment.captured` for the order's captured payment.
 */
export function normalizeRazorpayWebhook(body: unknown, eventIdHeader: string | null): WebhookVerification {
  const parsed = webhookEnvelope.safeParse(body);
  if (!parsed.success) {
    const type = typeof body === "object" && body !== null ? (body as { event?: unknown }).event : undefined;
    return typeof type === "string" && !SUPPORTED_EVENTS.has(type) ? UNSUPPORTED : INVALID;
  }
  const envelope = parsed.data;
  if (!SUPPORTED_EVENTS.has(envelope.event)) return UNSUPPORTED;
  const occurredAt = envelope.created_at ? new Date(envelope.created_at * 1000) : undefined;
  const payment = envelope.payload.payment?.entity;

  switch (envelope.event) {
    case "payment.captured":
    case "payment.failed": {
      if (!payment?.order_id) return INVALID;
      const id = eventIdFor(eventIdHeader, envelope.event, payment.id);
      return { ok: true, event: paymentEvent(envelope.event, payment.order_id, payment, id, occurredAt) };
    }
    case "order.paid": {
      const order = envelope.payload.order?.entity;
      if (!order || !payment || (payment.order_id && payment.order_id !== order.id)) return INVALID;
      const id = eventIdFor(eventIdHeader, envelope.event, order.id);
      return { ok: true, event: paymentEvent("payment.captured", order.id, payment, id, occurredAt) };
    }
    case "refund.processed":
    case "refund.failed": {
      const refund = envelope.payload.refund?.entity;
      if (!refund || !payment?.order_id || refund.payment_id !== payment.id) return INVALID;
      const event: NormalizedEvent = {
        id: eventIdFor(eventIdHeader, envelope.event, refund.id),
        type: envelope.event,
        providerOrderId: payment.order_id,
        providerPaymentId: refund.payment_id,
        providerRefundId: refund.id,
        amountPaise: refund.amount,
        currency: refund.currency,
      };
      if (occurredAt) event.occurredAt = occurredAt;
      return { ok: true, event };
    }
    default:
      return UNSUPPORTED;
  }
}

export type RazorpayConfig = {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** Defaults to https://api.razorpay.com/v1 (tests point it elsewhere). */
  baseUrl?: string;
  timeoutMs?: number;
  /** Injected fetch (tests). */
  fetch?: typeof fetch;
};

function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new PaymentProviderError("not_configured", `${name} is required for the Razorpay payment provider`, "razorpay");
  return value;
}

function assertPositivePaise(value: number, what: string): void {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new PaymentProviderError("invalid_request", `${what} must be a positive integer of paise`, "razorpay");
  }
}

function assertId(value: string, what: string): void {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    throw new PaymentProviderError("invalid_request", `${what} is not a valid Razorpay id`, "razorpay");
  }
}

function errorCodeFor(status: number, description: string): PaymentProviderErrorCode {
  if (status === 401) return "not_configured";
  if (status === 404) return "not_found";
  if (status === 400 && /does not exist|not found/i.test(description)) return "not_found";
  if (status === 429 || status >= 500) return "provider_error";
  return status >= 400 && status < 500 ? "invalid_request" : "provider_error";
}

/** Razorpay's error envelope `{ error: { code, description } }`; descriptions never carry instrument details. */
function errorDescription(data: unknown): { code: string; description: string } {
  const error = typeof data === "object" && data !== null ? (data as { error?: unknown }).error : undefined;
  const e = typeof error === "object" && error !== null ? (error as { code?: unknown; description?: unknown }) : {};
  const code = typeof e.code === "string" ? e.code.slice(0, 60) : "UNKNOWN";
  const description = typeof e.description === "string" ? e.description.replace(/\s+/g, " ").slice(0, 200) : "";
  return { code, description };
}

type RequestOptions = { method: "GET" | "POST"; path: string; label: string; body?: unknown };

/**
 * Razorpay PaymentProvider. The keys come from the caller: lib/payments/index.ts createPaymentProvider() hands it the
 * effective configuration (Admin > Settings > Integrations, else the env fallback; lib/integrations/resolver.ts).
 */
export class RazorpayProvider implements PaymentProvider {
  readonly key = "razorpay" as const;
  readonly keyId: string;
  readonly #keySecret: string;
  readonly #webhookSecret: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(config: RazorpayConfig) {
    this.keyId = requireSecret(config.keyId, "The Key ID");
    this.#keySecret = requireSecret(config.keySecret, "The key secret");
    this.#webhookSecret = requireSecret(config.webhookSecret, "The webhook secret");
    this.#baseUrl = (config.baseUrl ?? RAZORPAY_API_BASE).replace(/\/+$/, "");
    this.#timeoutMs = config.timeoutMs ?? RAZORPAY_DEFAULT_TIMEOUT_MS;
    this.#fetch = config.fetch ?? ((input, init) => fetch(input, init));
  }

  /** One API call. Logs the method, a path template and the outcome only (never bodies, ids of instruments or keys). */
  async #request<S extends z.ZodType>(opts: RequestOptions, schema: S): Promise<z.output<S>> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Basic ${Buffer.from(`${this.keyId}:${this.#keySecret}`, "utf8").toString("base64")}`,
    };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}${opts.path}`, {
        method: opts.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(this.#timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const timedOut = name === "TimeoutError" || name === "AbortError";
      log.warn("razorpay_request_failed", { method: opts.method, path: opts.label, reason: timedOut ? "timeout" : "network" });
      throw new PaymentProviderError(
        "provider_error",
        timedOut ? `Razorpay did not answer within ${this.#timeoutMs} ms` : "Could not reach Razorpay",
        "razorpay",
      );
    }
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const { code, description } = errorDescription(data);
      const errorCode = errorCodeFor(res.status, description);
      log.warn("razorpay_request_rejected", { method: opts.method, path: opts.label, status: res.status, razorpayError: code });
      throw new PaymentProviderError(errorCode, `Razorpay ${res.status} ${code}${description ? `: ${description}` : ""}`, "razorpay");
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      log.warn("razorpay_unexpected_response", { method: opts.method, path: opts.label, status: res.status });
      throw new PaymentProviderError("provider_error", "Unexpected response from Razorpay", "razorpay");
    }
    return parsed.data;
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    assertPositivePaise(input.amountPaise, "amountPaise");
    if (typeof input.orderId !== "string" || input.orderId.length === 0 || input.orderId.length > RECEIPT_MAX) {
      throw new PaymentProviderError("invalid_request", `orderId is required (at most ${RECEIPT_MAX} characters)`, "razorpay");
    }
    // The customer's contact details are not sent here; Checkout.js prefills them in the browser.
    const order = await this.#request(
      {
        method: "POST",
        path: "/orders",
        label: "/orders",
        body: { amount: input.amountPaise, currency: "INR", receipt: input.orderId, notes: { orderId: input.orderId } },
      },
      orderEntity,
    );
    if (order.amount !== input.amountPaise || order.currency !== "INR") {
      throw new PaymentProviderError("provider_error", "Razorpay created an order with a different amount or currency", "razorpay");
    }
    return {
      providerOrderId: order.id,
      checkout: { keyId: this.keyId, providerOrderId: order.id, amountPaise: input.amountPaise, currency: "INR" },
    };
  }

  verifyReturnSignature(input: ReturnSignatureInput): boolean {
    const { providerOrderId, providerPaymentId, signature } = input;
    if (typeof providerOrderId !== "string" || typeof providerPaymentId !== "string" || typeof signature !== "string") return false;
    if (providerOrderId.length === 0 || providerPaymentId.length === 0 || signature.length === 0) return false;
    return safeEqual(signature.trim().toLowerCase(), signRazorpayReturn(providerOrderId, providerPaymentId, this.#keySecret));
  }

  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification {
    const signature = headers.get(RAZORPAY_SIGNATURE_HEADER);
    if (!signature) return { ok: false, reason: "missing_signature", signatureOk: false };
    if (typeof rawBody !== "string" || Buffer.byteLength(rawBody, "utf8") > RAZORPAY_MAX_WEBHOOK_BYTES) {
      return { ok: false, reason: "invalid_payload", signatureOk: false };
    }
    if (!safeEqual(signature.trim().toLowerCase(), signRazorpayWebhook(rawBody, this.#webhookSecret))) {
      return { ok: false, reason: "invalid_signature", signatureOk: false };
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return INVALID;
    }
    return normalizeRazorpayWebhook(body, headers.get(RAZORPAY_EVENT_ID_HEADER));
  }

  async fetchPayment(providerPaymentId: string): Promise<NormalizedPayment> {
    assertId(providerPaymentId, "providerPaymentId");
    const entity = await this.#request(
      { method: "GET", path: `/payments/${encodeURIComponent(providerPaymentId)}`, label: "/payments/:id" },
      paymentEntity,
    );
    return normalizeRazorpayPayment(entity);
  }

  async fetchOrderPayments(providerOrderId: string): Promise<NormalizedPayment[]> {
    assertId(providerOrderId, "providerOrderId");
    const list = await this.#request(
      { method: "GET", path: `/orders/${encodeURIComponent(providerOrderId)}/payments`, label: "/orders/:id/payments" },
      collection(paymentEntity),
    );
    return list.items.map((entity) => normalizeRazorpayPayment(entity, providerOrderId));
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    assertId(input.providerPaymentId, "providerPaymentId");
    assertPositivePaise(input.amountPaise, "amountPaise");
    const reason = typeof input.reason === "string" ? input.reason.replace(/\s+/g, " ").trim() : "";
    if (reason.length === 0) throw new PaymentProviderError("invalid_request", "A refund reason is required", "razorpay");
    const refund = await this.#request(
      {
        method: "POST",
        path: `/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
        label: "/payments/:id/refund",
        body: { amount: input.amountPaise, notes: { reason: reason.slice(0, NOTE_MAX) } },
      },
      refundEntity,
    );
    return { providerRefundId: refund.id };
  }

  async fetchRefund(providerRefundId: string): Promise<NormalizedRefund> {
    assertId(providerRefundId, "providerRefundId");
    const refund = await this.#request(
      { method: "GET", path: `/refunds/${encodeURIComponent(providerRefundId)}`, label: "/refunds/:id" },
      refundEntity,
    );
    return normalizeRazorpayRefund(refund);
  }

  /**
   * Admin "Test Razorpay keys" (lib/integrations/probes.ts): one authenticated, read-only call (GET /orders?count=1).
   * "rejected" when Razorpay answers 401 (wrong Key ID or key secret); any other failure throws provider_error.
   * Never echoes a key.
   */
  async checkCredentials(): Promise<"ok" | "rejected"> {
    try {
      await this.#request({ method: "GET", path: "/orders?count=1", label: "/orders" }, z.looseObject({}));
      return "ok";
    } catch (error) {
      if (error instanceof PaymentProviderError && error.code === "not_configured") return "rejected";
      throw new PaymentProviderError("provider_error", "Could not check the keys with Razorpay", "razorpay");
    }
  }
}
