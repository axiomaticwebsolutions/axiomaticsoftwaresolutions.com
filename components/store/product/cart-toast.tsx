"use client";

import Link from "next/link";
import type * as React from "react";
import { Icon } from "@/components/icons/icon";
import { toast } from "@/components/ui/sonner";
import { PRODUCT_COPY } from "./copy";

/** Product page toast (prototype): bottom-right, 6 s, "View cart" / "Keep browsing". */
export const CART_TOAST_DURATION_MS = 6000;

// The li comes from StoreToaster (bottom-center look); these important overrides give the prototype's card:
// radius 18, padding 16px 18px, content aligned to the top, a larger shadow and 380px wide (Sonner's own mobile
// layout, full width minus 16px, applies below 600px).
const TOAST_CLASSES =
  "items-start! rounded-18! px-[18px]! py-4! shadow-[0_20px_50px]! shadow-ink/30! min-[37.5rem]:w-[380px]!";

let lastToastId: string | number | undefined;

type CartToastProps = { id: string | number; title: string; detail: string };

function CartToast({ id, title, detail }: CartToastProps) {
  const close = () => toast.dismiss(id);
  // Escape on either action closes the toast (keyboard users reach it with Tab or Sonner's Alt+T).
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };
  return (
    <div className="w-full text-[16px] font-normal leading-[normal] text-white">
      <div className="flex items-start gap-2.5">
        <Icon name="check_circle" size={22} className="text-success-soft" />
        <div className="min-w-0 flex-1">
          <p className="m-0 font-extrabold">{title}</p>
          <p className="m-0 mt-[3px] text-[14px] text-admin-text">{detail}</p>
        </div>
      </div>
      <div className="mt-3.5 flex gap-2">
        <Link
          href="/cart"
          onClick={close}
          onKeyDown={onKeyDown}
          className="flex-1 rounded-[11px] bg-surface p-2.5 text-center font-extrabold text-ink no-underline transition-colors hover:bg-lavender-bg hover:text-ink"
        >
          {PRODUCT_COPY.toastViewCart}
        </Link>
        <button
          type="button"
          onClick={close}
          onKeyDown={onKeyDown}
          className="flex-1 cursor-pointer rounded-[11px] border border-surface/25 bg-transparent p-2.5 font-bold text-white transition-colors hover:bg-surface/10"
        >
          {PRODUCT_COPY.toastKeepBrowsing}
        </button>
      </div>
    </div>
  );
}

/**
 * Shows the "Added to cart" toast, replacing the previous one (a new toast restarts the 6 s timer, as the prototype
 * does). Sonner's polite live region announces it; hovering it, or moving to it with Alt+T, pauses the timer; Escape
 * closes it. Its actions repeat the header's cart button, so nothing is lost when it times out (WCAG 2.2.1).
 */
export function showCartToast({ title, detail }: { title: string; detail: string }): void {
  if (lastToastId !== undefined) toast.dismiss(lastToastId);
  lastToastId = toast.custom((id) => <CartToast id={id} title={title} detail={detail} />, {
    position: "bottom-right",
    duration: CART_TOAST_DURATION_MS,
    classNames: { toast: TOAST_CLASSES },
  });
}
