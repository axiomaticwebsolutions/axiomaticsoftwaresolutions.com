import Link from "next/link";
import { CHECKOUT_COPY } from "@/components/checkout/checkout-form";
import { CheckoutView } from "@/components/checkout/checkout-view";
import { loadCheckoutViewer } from "@/components/checkout/checkout-viewer";
import { toCartPlanCatalog } from "@/components/store/cart/cart-model";
import { resolvePayments } from "@/lib/integrations/resolver";
import { buildMetadata } from "@/lib/seo/metadata";
import { getStoreProducts, getStoreSettings } from "@/lib/storefront/data";

export const metadata = buildMetadata({
  title: "Checkout",
  description: "Enter your billing details and pay securely. Licenses are issued once the payment is confirmed.",
  path: "/checkout",
  noindex: true,
});

/**
 * /checkout (Checkout.dc.html). Dynamic: the signed-in identity and account billing details prefill the form on the
 * server (no flash). The cart itself is read on the client; prices come from POST /api/checkout/quote. When no payment
 * provider is configured (lib/integrations/resolver.ts) the page says so and Pay is disabled; the API answers 503
 * `payments_unavailable` anyway.
 */
export default async function CheckoutPage() {
  const [products, settings, { viewer, prefill }, payments] = await Promise.all([
    getStoreProducts(),
    getStoreSettings(),
    loadCheckoutViewer(),
    resolvePayments().catch(() => null),
  ]);
  // A resolver failure (database down) leaves Pay enabled: the API answers with its own error then.
  const paymentsAvailable = payments === null || payments.source !== "none";
  return (
    <div className="mx-auto max-w-[1120px] px-4 pb-24 pt-7 leading-[normal] sm:px-6">
      <Link href="/cart" className="rounded-6 text-[14px] font-bold text-primary-link no-underline hover:text-primary-link-hover">
        {CHECKOUT_COPY.backToCart}
      </Link>
      <h1 className="mb-0 mt-3.5 text-[clamp(30px,3.6vw,40px)] font-extrabold tracking-[-0.035em]">{CHECKOUT_COPY.title}</h1>
      <CheckoutView
        catalog={toCartPlanCatalog(products)}
        companyState={settings.business.state}
        viewer={viewer}
        prefill={prefill}
        showSampleCodes={settings.business.sample}
        paymentsAvailable={paymentsAvailable}
      />
    </div>
  );
}
