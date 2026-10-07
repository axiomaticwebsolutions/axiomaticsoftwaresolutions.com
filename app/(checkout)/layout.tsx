import type * as React from "react";
import { CheckoutHeader } from "@/components/checkout/checkout-header";
import { SkipLink } from "@/components/store/skip-link";

/**
 * Checkout shell (Checkout.dc.html): the minimal header (logo + "Secure checkout") instead of the storefront header
 * and footer, then <main id="main">. The skip link is kept for keyboard users.
 */
export default function CheckoutLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <SkipLink />
      <CheckoutHeader />
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
    </div>
  );
}
