"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { DisabledAction } from "@/components/account/disabled-action";
import { usePortal } from "@/components/account/portal-context";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/sonner";
import { cartStore } from "@/lib/cart/store";
import type { RenewalOption } from "@/lib/licensing/account";
import { cn } from "@/lib/utils";
import { addRenewalToCart, CART_FULL_MESSAGE, CART_PATH, CART_UNAVAILABLE_MESSAGE } from "./cart-renewal";

export type RenewToCartButtonProps = {
  licenseId: string;
  renewal: Pick<RenewalOption, "kind" | "planId" | "qty">;
  /** Visible label ("Renew", "Renew now", "Buy a license"). */
  children: React.ReactNode;
  /** Visually hidden text completing the label for screen readers, e.g. " LIC-24017". */
  srSuffix?: string;
  className?: string;
};

/**
 * Adds the license's renewal (or a trial's conversion) to the cart and opens /cart (prototype addRenewal). Members
 * without the `purchases` permission (Technical contact, Viewer) get the same button disabled with "Requires Owner or
 * Billing admin" (decisions.md Phase 5); checkout enforces the same rule.
 */
export function RenewToCartButton({ licenseId, renewal, children, srSuffix, className }: RenewToCartButtonProps) {
  const { can } = usePortal();
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const label = (
    <>
      {children}
      {srSuffix ? <span className="sr-only">{srSuffix}</span> : null}
    </>
  );

  if (!can("purchases")) {
    return (
      <DisabledAction perm="purchases" asChild>
        <button type="button" className={className}>
          {label}
        </button>
      </DisabledAction>
    );
  }

  function renew() {
    if (busy) return;
    const result = addRenewalToCart(cartStore, licenseId, renewal);
    if (!result.ok) {
      toast.error(result.reason === "full" ? CART_FULL_MESSAGE : CART_UNAVAILABLE_MESSAGE);
      return;
    }
    setBusy(true);
    router.push(CART_PATH);
  }

  return (
    <button
      type="button"
      onClick={renew}
      aria-busy={busy || undefined}
      className={cn("inline-flex items-center justify-center gap-1.5", className)}
    >
      {busy ? <Spinner size="sm" tone="current" /> : null}
      {label}
    </button>
  );
}
