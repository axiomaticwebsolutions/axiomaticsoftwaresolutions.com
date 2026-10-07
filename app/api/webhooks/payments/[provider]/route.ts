/**
 * POST /api/webhooks/payments/:provider: payment provider webhooks (docs/api-contracts.md section 4).
 *
 * Signature-authenticated: no session, no CSRF token (lib/auth/csrf.ts exempts /api/webhooks/*), no same-origin check
 * (the caller is the provider's server). Only the configured provider (PAYMENT_PROVIDER) is accepted; anything else
 * is a 404. The exact request text (at most 256 KB) goes to the adapter, which verifies the HMAC with
 * PAYMENT_WEBHOOK_SECRET in constant time:
 * - missing or bad signature -> 401 `invalid_signature`, a WebhookDelivery(invalid_signature) row, no state change;
 * - valid signature, body not understood -> 200 `{ result: "invalid_payload" }` (retrying would not help);
 * - valid signature, an event type the order state machine ignores -> 200 `{ result: "ignored" }`;
 * - otherwise lib/payments/webhook.ts processPaymentEvent() -> 200 `{ result }` once committed. Errors other than a
 *   handled outcome (database unavailable) answer 500 so the provider retries.
 * Valid deliveries are never rate limited: providers retry on any non-2xx, so a throttled genuine event would only
 * delay a paid order, and the HMAC check is cheap. Rejected signatures are counted per client IP
 * (INVALID_SIGNATURE_RULE) and stop being recorded once over the limit, so unsigned floods cannot grow
 * WebhookDelivery without bound; they still get a 401. Responses are `Cache-Control: no-store` and never echo input.
 */
import { hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ApiError, clientIp, errors, json, route } from "@/lib/http";
import { log } from "@/lib/log";
import { getPaymentProvider, isPaymentProviderKey } from "@/lib/payments";
import { RAZORPAY_MAX_WEBHOOK_BYTES } from "@/lib/payments/razorpay";
import { processPaymentEvent, recordWebhookDelivery, type WebhookDeliveryInput } from "@/lib/payments/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WEBHOOK_BYTES = RAZORPAY_MAX_WEBHOOK_BYTES;
const INVALID_SIGNATURE_MESSAGE = "The webhook signature is not valid.";

type Context = { params: Promise<{ provider: string }> };

/** The exact body text, refusing more than `maxBytes` (checked while streaming, not only via Content-Length). */
async function readRawBody(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw errors.payloadTooLarge(maxBytes);
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw errors.payloadTooLarge(maxBytes);
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return null; // Not UTF-8, so it cannot carry a valid signature over the provider's JSON.
  }
}

async function recordDelivery(input: WebhookDeliveryInput): Promise<void> {
  try {
    await recordWebhookDelivery(input);
  } catch (error) {
    log.error("webhook_delivery_record_failed", { provider: input.provider, result: input.result, error: error instanceof Error ? error.name : "unknown" });
  }
}

async function underInvalidSignatureLimit(req: Request): Promise<boolean> {
  try {
    return (await hit(db, RATE_LIMITS.webhookInvalidIp(clientIp(req)))).allowed;
  } catch (error) {
    log.warn("webhook_rate_limit_unavailable", { error: error instanceof Error ? error.name : "unknown" });
    return true;
  }
}

export const POST = route<Context>(async (req, ctx) => {
  const { provider: key } = await ctx.params;
  if (!isPaymentProviderKey(key) || key !== getEnv().PAYMENT_PROVIDER) throw errors.notFound();
  const provider = getPaymentProvider(key);

  const rawBody = await readRawBody(req, MAX_WEBHOOK_BYTES);
  const verification =
    rawBody === null ? ({ ok: false, reason: "invalid_signature", signatureOk: false } as const) : provider.verifyWebhook(rawBody, req.headers);

  if (!verification.ok) {
    if (!verification.signatureOk) {
      if (await underInvalidSignatureLimit(req)) {
        await recordDelivery({ provider: key, signatureOk: false, result: "invalid_signature" });
      }
      log.warn("webhook_signature_rejected", { provider: key, reason: verification.reason });
      throw new ApiError(401, "invalid_signature", INVALID_SIGNATURE_MESSAGE);
    }
    const result = verification.reason === "unsupported_event" ? "ignored" : "invalid_payload";
    await recordDelivery({ provider: key, signatureOk: true, result });
    if (result === "invalid_payload") log.warn("webhook_payload_rejected", { provider: key });
    return json({ result });
  }

  const { status, result } = await processPaymentEvent(key, verification.event);
  return json({ result }, { status });
});
