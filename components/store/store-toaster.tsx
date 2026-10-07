"use client";

import type * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";

// Toasts size to their text like the prototype's, up to 540px (Sonner's default 356px column wrapped the
// compare-limit message onto two lines). Below 601px Sonner's own full-width mobile layout applies.
const TOASTER_STYLE = { "--width": "min(540px, calc(100vw - 32px))" } as React.CSSProperties;

// Shrink-to-fit and centred in the bottom-center column (601px and up; the column itself is --width wide).
const CENTERED_FIT =
  "min-[37.5625rem]:data-[x-position=center]:inset-x-0 min-[37.5625rem]:data-[x-position=center]:mx-auto min-[37.5625rem]:data-[x-position=center]:w-fit";

/**
 * Storefront toasts (README > Toasts): dark ink, radius 14, 14.5px/600, toast shadow, bottom-center, ~3.2s. Mount once,
 * in the store layout. Pages call `toast()` from components/ui/sonner; a page can pass `position` (e.g. the product
 * page's bottom-right "Added to cart" toast) and `duration` per toast. The info icon uses the peach mark accent, as
 * on the catalog's compare-limit toast.
 */
export function StoreToaster() {
  return (
    <Toaster
      position="bottom-center"
      containerAriaLabel="Notifications"
      style={TOASTER_STYLE}
      icons={{
        success: <Icon name="check_circle" size={20} className="text-success-soft" />,
        error: <Icon name="error" size={20} className="text-pink-line" />,
        warning: <Icon name="warning" size={20} className="text-peach-line" />,
        info: <Icon name="info" size={20} className="text-brand-mark-accent" />,
        loading: <Spinner tone="onPrimary" size="sm" />,
        close: <Icon name="close" size={16} />,
      }}
      toastOptions={{
        classNames: {
          toast: `flex max-w-full items-center gap-2.5 rounded-14 bg-ink px-[18px] py-3 text-[14.5px] font-semibold text-white shadow-toast [&_:focus-visible]:outline-primary-accent ${CENTERED_FIT}`,
          // 24px like the prototype's 20px icon-font glyph, so a one-line toast is 48px tall.
          icon: "flex h-6 shrink-0 items-center",
        },
      }}
    />
  );
}
