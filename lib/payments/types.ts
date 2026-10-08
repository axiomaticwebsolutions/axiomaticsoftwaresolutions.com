/**
 * Payment provider adapter (docs/api-contracts.md section 8). Route handlers, the webhook handler and the
 * reconciliation job only talk to this interface, so Razorpay, Cashfree and the mock share one code path.
 * Amounts are integer paise. No card numbers, VPAs or other instrument details ever cross this boundary.
 */

export const PAYMENT_PROVIDER_KEYS = ["razorpay", "cashfree", "mock"] as const;
export type PaymentProviderKey = (typeof PAYMENT_PROVIDER_KEYS)[number];

/**
 * Payment.provider of a payment Owner or Finance recorded in Admin > Orders (cash, UPI, bank transfer, cheque). Not a
 * PaymentProviderKey: no adapter, never reconciled or refunded through a provider (docs/decisions.md "Admin records").
 */
export const OFFLINE_PROVIDER = "offline";
/** Payment.providerOrderId of an offline payment (unique, because order ids are). */
export function offlineProviderOrderId(orderId: string): string {
  return `offline:${orderId}`;
}

export const PAYMENT_EVENT_TYPES = ["payment.captured", "payment.failed", "refund.processed", "refund.failed"] as const;
export type PaymentEventType = (typeof PAYMENT_EVENT_TYPES)[number];

/** A provider webhook reduced to what the order state machine needs. `id` is the provider's event id. */
export type NormalizedEvent = {
  id: string;
  type: PaymentEventType;
  providerOrderId: string;
  providerPaymentId?: string;
  /** refund.processed / refund.failed only: matches Refund.providerRefundId. */
  providerRefundId?: string;
  amountPaise: number;
  /**
   * ISO 4217 code as the provider reported it. Orders are always INR, so anything else is a mismatch the webhook
   * handler sends to REVIEW (widened from "INR" in Phase 3 so a foreign-currency event can be represented).
   */
  currency: string;
  /** Display label only ("UPI", "Card", "Net banking"); never instrument details. */
  method?: string;
  failureReason?: string;
  /**
   * When the provider created the event (Razorpay: the envelope's created_at). Used as Order.paidAt when it is not
   * in the future. In-process only: the mock webhook wire format does not carry it.
   */
  occurredAt?: Date;
};

export type NormalizedPaymentStatus = "created" | "authorized" | "captured" | "failed" | "refunded";

/** A refund as the provider reports it (reconciliation of refunds whose webhook never arrived). */
export type NormalizedRefund = {
  providerRefundId: string;
  providerPaymentId: string;
  status: "pending" | "processed" | "failed";
  amountPaise: number;
  currency: string;
};

/** A payment as the provider reports it, for reconciliation and admin views. */
export type NormalizedPayment = {
  providerPaymentId: string;
  providerOrderId: string;
  status: NormalizedPaymentStatus;
  amountPaise: number;
  /** ISO 4217 code as the provider reported it (see NormalizedEvent.currency). */
  currency: string;
  method?: string;
  failureReason?: string;
};

export type CreateOrderInput = { orderId: string; amountPaise: number; customer: { email: string; phone?: string } };
/** `checkout` is handed to the client to open the hosted checkout (for the mock: `{ url, keyId }`). */
export type CreateOrderResult = { providerOrderId: string; checkout: Record<string, unknown> };
export type ReturnSignatureInput = { providerOrderId: string; providerPaymentId: string; signature: string };
export type RefundInput = { providerPaymentId: string; amountPaise: number; reason: string };
export type RefundResult = { providerRefundId: string };

/**
 * Why a webhook was rejected. `unsupported_event` means the signature was valid but the event type is one the
 * order state machine ignores: answer 200 so the provider stops retrying.
 */
export type WebhookRejection = "missing_signature" | "invalid_signature" | "invalid_payload" | "unsupported_event";

/** Assignable to the contract's `{ ok: boolean; event?: NormalizedEvent }`, with a reason on failure. */
export type WebhookVerification =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; event?: undefined; reason: WebhookRejection; signatureOk: boolean };

export interface PaymentProvider {
  readonly key: PaymentProviderKey;
  /**
   * The key id provider orders are created with (Razorpay Key ID; "mock_key" for the mock). Stored on Payment as
   * providerKeyId: attempts made with other keys are never reopened with these; reconcile and refunds reach other key
   * ids of the same Razorpay mode too (regenerated keys of the same account; lib/payments/key-scope.ts).
   */
  readonly keyId: string;
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
  /** Hosted-checkout return signature; constant-time. Never fulfils anything by itself. */
  verifyReturnSignature(input: ReturnSignatureInput): boolean;
  /** `rawBody` must be the exact request text (`await req.text()`), never re-serialised JSON. */
  verifyWebhook(rawBody: string, headers: Headers): WebhookVerification;
  fetchPayment(providerPaymentId: string): Promise<NormalizedPayment>;
  /** Every payment attempt for a provider order, for the reconciliation job. */
  fetchOrderPayments(providerOrderId: string): Promise<NormalizedPayment[]>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** One refund's current state, for the reconciliation of refunds still PENDING after a day. */
  fetchRefund(providerRefundId: string): Promise<NormalizedRefund>;
}

export type PaymentProviderErrorCode = "not_configured" | "invalid_request" | "not_found" | "provider_error";

/** Adapter failures with a stable code. Messages are for logs and staff, not for customers. */
export class PaymentProviderError extends Error {
  readonly code: PaymentProviderErrorCode;
  readonly provider: PaymentProviderKey | null;

  constructor(code: PaymentProviderErrorCode, message: string, provider: PaymentProviderKey | null = null) {
    super(message);
    this.name = "PaymentProviderError";
    this.code = code;
    this.provider = provider;
  }
}

export function isPaymentProviderKey(value: unknown): value is PaymentProviderKey {
  return typeof value === "string" && (PAYMENT_PROVIDER_KEYS as readonly string[]).includes(value);
}
