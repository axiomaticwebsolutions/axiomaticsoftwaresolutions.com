/**
 * Provider selection. Route handlers never import an adapter directly: they ask for the ACTIVE provider, built from the
 * effective payments configuration (Admin > Settings > Integrations, else the env fallback; lib/integrations/resolver.ts).
 * Razorpay is the production adapter; the mock serves tests and local development (env-only, refused in production).
 * Cashfree has no adapter yet.
 *
 * - activePaymentProvider() / activePaymentProviderOrNull(): the adapter of the effective configuration, rebuilt when it
 *   changes (cached per configuration fingerprint). Not configured -> PaymentProviderError("not_configured") / null.
 * - createPaymentProvider(config): a one-off adapter for a configuration (the Admin "Test Razorpay keys" probe).
 * - getPaymentProvider("mock"): the env mock, synchronous, for tests and the dev mock routes; refused in production.
 */
import "server-only";
import { isProduction } from "@/lib/env";
import { resolvePayments } from "@/lib/integrations/resolver";
import type { PaymentsConfig } from "@/lib/integrations/types";
import { MockProvider } from "./mock";
import { RazorpayProvider, type RazorpayConfig } from "./razorpay";
import { PaymentProviderError, type PaymentProvider } from "./types";

export * from "./types";

/** Customer-facing copy when no payment provider is configured (checkout, order retry, refunds). */
export const PAYMENTS_UNAVAILABLE_MESSAGE = "Payments aren’t available yet. Please try again later.";

/** An adapter for a resolved configuration. The mock is refused in production. */
export function createPaymentProvider(config: PaymentsConfig, extra: Pick<RazorpayConfig, "fetch" | "baseUrl" | "timeoutMs"> = {}): PaymentProvider {
  if (config.provider === "mock") {
    if (isProduction()) throw new PaymentProviderError("not_configured", "The mock payment provider is disabled in production", "mock");
    return new MockProvider({ keyId: config.keyId, keySecret: config.keySecret, webhookSecret: config.webhookSecret });
  }
  return new RazorpayProvider({ keyId: config.keyId, keySecret: config.keySecret, webhookSecret: config.webhookSecret, ...extra });
}

type ActiveSlot = { fingerprint: string; provider: PaymentProvider } | null;
let active: ActiveSlot = null;
let envMock: MockProvider | null = null;

/** The adapter of the effective payments configuration, or null when payments are not configured. */
export async function activePaymentProviderOrNull(): Promise<PaymentProvider | null> {
  const resolved = await resolvePayments();
  if (resolved.source === "none") return null;
  if (active?.fingerprint !== resolved.fingerprint) {
    active = { fingerprint: resolved.fingerprint, provider: createPaymentProvider(resolved.config) };
  }
  return active.provider;
}

/** Like activePaymentProviderOrNull(), but throws PaymentProviderError("not_configured") when there is none. */
export async function activePaymentProvider(): Promise<PaymentProvider> {
  const provider = await activePaymentProviderOrNull();
  if (!provider) throw new PaymentProviderError("not_configured", "Payments are not configured.", null);
  return provider;
}

/**
 * The env mock (PAYMENT_KEY_ID / PAYMENT_KEY_SECRET / PAYMENT_WEBHOOK_SECRET), one instance per process. Tests and the
 * development mock routes only; refused in production.
 */
export function getPaymentProvider(key: "mock"): PaymentProvider {
  if (key !== "mock" || isProduction()) {
    throw new PaymentProviderError("not_configured", "The mock payment provider is disabled in production", "mock");
  }
  envMock ??= new MockProvider();
  return envMock;
}

/** Drops cached adapters (tests that change the environment). */
export function resetPaymentProviders(): void {
  active = null;
  envMock = null;
}
