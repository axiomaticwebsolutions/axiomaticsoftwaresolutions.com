import Link from "next/link";
import { BrandLogoSwap } from "@/components/brand/branding-context";
import { LogoMark } from "@/components/brand/logo";
import { Icon } from "@/components/icons/icon";
import { CHECKOUT_COPY } from "./checkout-form";

/**
 * Minimal checkout header (Checkout.dc.html): white 68px bar, 32px mark + "Axiomatic" (or the logo uploaded in Admin >
 * Settings > Branding, 32px tall), and the sage "Secure checkout" lock on the right. No navigation, so nothing pulls
 * the buyer out of the form. Server-safe.
 */
export function CheckoutHeader() {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex h-[68px] max-w-[1120px] items-center justify-between gap-4 px-4 leading-[normal] sm:px-6">
        <Link
          href="/"
          aria-label="Axiomatic Software Solutions — home"
          className="flex items-center gap-2.5 rounded-10 text-ink no-underline"
        >
          <BrandLogoSwap height={32} maxWidth={160}>
            <LogoMark size={32} />
            <span className="text-[18px] font-extrabold tracking-[-0.025em]">Axiomatic</span>
          </BrandLogoSwap>
        </Link>
        <span className="flex items-center gap-1.5 text-[14px] font-bold text-sage-fg">
          <Icon name="lock" size={19} />
          {CHECKOUT_COPY.secure}
        </span>
      </div>
    </header>
  );
}
