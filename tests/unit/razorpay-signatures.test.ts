import { describe, expect, it } from "vitest";
import {
  RAZORPAY_MAX_WEBHOOK_BYTES,
  RazorpayProvider,
  signRazorpayReturn,
  signRazorpayWebhook,
} from "@/lib/payments/razorpay";

// Expected digests were computed independently with OpenSSL, e.g.
//   printf '%s' 'order_IluGWxBm9U8zJ8|pay_IluH2c4Iq7DkgN' | openssl dgst -sha256 -hmac 'EnLs21M47BllR3X8PSFtjtbd'
const KEY_SECRET = "EnLs21M47BllR3X8PSFtjtbd";
const WEBHOOK_SECRET = "whsec_9fJ2kLq8Zt3Xw7Rp";
const ORDER_ID = "order_IluGWxBm9U8zJ8";
const PAYMENT_ID = "pay_IluH2c4Iq7DkgN";
const RETURN_SIGNATURE = "c03c3b59357c36715a90c9b94e5b55f880b0be92a9048568fe275970ecc86f45";
const WEBHOOK_BODY = '{"entity":"event","event":"payment.captured"}';
const WEBHOOK_SIGNATURE = "9460db9f5579a8e0c465a8686ed76e6bcf23fbc75a752b8d526201a3a75a95af";
// RFC 4231 test case 2 (HMAC-SHA256).
const RFC_KEY = "Jefe";
const RFC_DATA = "what do ya want for nothing?";
const RFC_DIGEST = "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843";

const noNetwork = (() => {
  throw new Error("unit tests never reach the network");
}) as unknown as typeof fetch;

function provider(webhookSecret = WEBHOOK_SECRET): RazorpayProvider {
  return new RazorpayProvider({ keyId: "rzp_test_1DP5mmOlF5G5ag", keySecret: KEY_SECRET, webhookSecret, fetch: noNetwork });
}

describe("known vectors", () => {
  it("computes hex HMAC-SHA256 (RFC 4231 test case 2)", () => {
    expect(signRazorpayWebhook(RFC_DATA, RFC_KEY)).toBe(RFC_DIGEST);
  });

  it("signs the checkout return as HMAC(key_secret, order_id|payment_id)", () => {
    expect(signRazorpayReturn(ORDER_ID, PAYMENT_ID, KEY_SECRET)).toBe(RETURN_SIGNATURE);
  });

  it("signs the exact webhook body with the webhook secret", () => {
    expect(signRazorpayWebhook(WEBHOOK_BODY, WEBHOOK_SECRET)).toBe(WEBHOOK_SIGNATURE);
  });
});

describe("verifyReturnSignature", () => {
  const p = provider();
  const ids = { providerOrderId: ORDER_ID, providerPaymentId: PAYMENT_ID };

  it("accepts the known signature, also in upper case or with whitespace", () => {
    expect(p.verifyReturnSignature({ ...ids, signature: RETURN_SIGNATURE })).toBe(true);
    expect(p.verifyReturnSignature({ ...ids, signature: RETURN_SIGNATURE.toUpperCase() })).toBe(true);
    expect(p.verifyReturnSignature({ ...ids, signature: ` ${RETURN_SIGNATURE}\n` })).toBe(true);
  });

  it("rejects swapped or tampered ids, another secret and junk", () => {
    expect(p.verifyReturnSignature({ providerOrderId: PAYMENT_ID, providerPaymentId: ORDER_ID, signature: RETURN_SIGNATURE })).toBe(false);
    expect(p.verifyReturnSignature({ ...ids, providerPaymentId: "pay_IluH2c4Iq7DkgM", signature: RETURN_SIGNATURE })).toBe(false);
    expect(p.verifyReturnSignature({ ...ids, signature: RETURN_SIGNATURE.replace(/^c/, "d") })).toBe(false);
    expect(p.verifyReturnSignature({ ...ids, signature: signRazorpayReturn(ORDER_ID, PAYMENT_ID, "another-secret") })).toBe(false);
    expect(p.verifyReturnSignature({ ...ids, signature: "" })).toBe(false);
    expect(p.verifyReturnSignature({ ...ids, providerOrderId: "", signature: RETURN_SIGNATURE })).toBe(false);
    expect(p.verifyReturnSignature({ ...ids, signature: 42 as unknown as string })).toBe(false);
  });
});

describe("verifyWebhook signatures", () => {
  it("accepts the known signature (the body then fails normalization, but the signature passed)", () => {
    const result = provider().verifyWebhook(WEBHOOK_BODY, new Headers({ "X-Razorpay-Signature": WEBHOOK_SIGNATURE }));
    expect(result).toEqual({ ok: false, reason: "invalid_payload", signatureOk: true });
  });

  it("accepts the RFC 4231 vector as a signature over a non-JSON body", () => {
    const result = provider(RFC_KEY).verifyWebhook(RFC_DATA, new Headers({ "x-razorpay-signature": RFC_DIGEST }));
    expect(result).toEqual({ ok: false, reason: "invalid_payload", signatureOk: true });
  });

  it("rejects a missing, wrong or truncated signature", () => {
    const p = provider();
    expect(p.verifyWebhook(WEBHOOK_BODY, new Headers())).toEqual({ ok: false, reason: "missing_signature", signatureOk: false });
    for (const signature of [RETURN_SIGNATURE, WEBHOOK_SIGNATURE.slice(0, 63), "not-hex", signRazorpayWebhook(WEBHOOK_BODY, "other")]) {
      expect(p.verifyWebhook(WEBHOOK_BODY, new Headers({ "x-razorpay-signature": signature }))).toEqual({
        ok: false,
        reason: "invalid_signature",
        signatureOk: false,
      });
    }
  });

  it("is computed over the exact bytes: re-serialised JSON does not verify", () => {
    const reserialised = JSON.stringify(JSON.parse(WEBHOOK_BODY), null, 1);
    const result = provider().verifyWebhook(reserialised, new Headers({ "x-razorpay-signature": WEBHOOK_SIGNATURE }));
    expect(result).toMatchObject({ ok: false, reason: "invalid_signature" });
  });

  it("refuses oversized bodies before hashing them", () => {
    const big = `{"pad":"${"x".repeat(RAZORPAY_MAX_WEBHOOK_BYTES)}"}`;
    const result = provider().verifyWebhook(big, new Headers({ "x-razorpay-signature": signRazorpayWebhook(big, WEBHOOK_SECRET) }));
    expect(result).toEqual({ ok: false, reason: "invalid_payload", signatureOk: false });
  });
});
