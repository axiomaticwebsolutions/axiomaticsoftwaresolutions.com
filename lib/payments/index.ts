/**
 * Provider selection. Route handlers call getPaymentProvider() and never import an adapter directly, so switching
 * PAYMENT_PROVIDER is a configuration change. Razorpay is the production adapter; the mock serves tests and local
 * development (lib/env.ts refuses it in production). Cashfree has no adapter yet.
 */
import { getEnv, isProduction } from "@/lib/env";
import { MockProvider } from "./mock";
import { RazorpayProvider } from "./razorpay";
import { PaymentProviderError, type PaymentProvider, type PaymentProviderKey } from "./types";

export * from "./types";

const providers = new Map<PaymentProviderKey, PaymentProvider>();

/** The configured adapter (one instance per process). Throws PaymentProviderError("not_configured") when unavailable. */
export function getPaymentProvider(key: PaymentProviderKey = getEnv().PAYMENT_PROVIDER): PaymentProvider {
  const cached = providers.get(key);
  if (cached) return cached;

  let provider: PaymentProvider;
  switch (key) {
    case "mock":
      // lib/env.ts already refuses PAYMENT_PROVIDER=mock in production; this also covers an explicit key argument.
      if (isProduction()) throw new PaymentProviderError("not_configured", "The mock payment provider is disabled in production", "mock");
      provider = new MockProvider();
      break;
    case "razorpay":
      provider = new RazorpayProvider();
      break;
    case "cashfree":
      throw new PaymentProviderError("not_configured", "The cashfree payment adapter is not available yet; use razorpay or mock", key);
  }
  providers.set(key, provider);
  return provider;
}

/** Drops cached adapters (tests that change the environment). */
export function resetPaymentProviders(): void {
  providers.clear();
}
