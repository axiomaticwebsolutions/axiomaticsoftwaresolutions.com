import Link from "next/link";
import type * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Two-thirds items panel + one-third summary (prototype: auto-fit columns of at least 340px). */
export const CART_GRID_CLASS =
  "mt-7 grid grid-cols-[repeat(auto-fit,minmax(min(100%,340px),1fr))] items-start gap-6";
/** The items panel spans two columns once there are two (in one column, span 2 would add a phantom column). */
export const CART_MAIN_SPAN_CLASS = "min-w-0 min-[47rem]:col-span-2";

export const CART_COPY = {
  emptyTitle: "Your cart is empty",
  emptyBody: "Choose a plan on any product page to add it here. Free trials don’t need a cart.",
  browse: "Browse software",
  continueShopping: "← Continue shopping",
  couponsAtCheckout: "Coupons can be applied at checkout.",
  summary: "Summary",
  subtotal: "Subtotal",
  gst: (rate: string) => `GST (${rate}%)`,
  estimatedTotal: "Estimated total",
  taxNote: "Prices exclude GST. Final CGST/SGST or IGST is calculated from your billing state at checkout.",
  continueToCheckout: "Continue to checkout",
  guestNote: "Guest checkout available. Sign in later with the same email to manage your licenses.",
  loading: "Loading your cart",
  updating: "Updating prices",
  tryAgain: "Try again",
  removed: (label: string) => `${label.replace(/^Remove /, "")} removed from your cart.`,
} as const;

export type EmptyCartProps = { headingRef?: React.Ref<HTMLHeadingElement> };

/** "Your cart is empty" (dashed card, bag tile, Browse software). */
export function EmptyCart({ headingRef }: EmptyCartProps) {
  return (
    <div className="mt-7 rounded-24 border border-dashed border-line-input bg-surface p-[clamp(36px,6vw,64px)] text-center">
      <span
        aria-hidden="true"
        className="mx-auto grid size-16 place-items-center rounded-20 bg-lavender-bg text-lavender-fg"
      >
        <Icon name="shopping_bag" size={32} />
      </span>
      <h2 ref={headingRef} tabIndex={-1} className="mb-0 mt-[18px] text-[22px] font-extrabold outline-none">
        {CART_COPY.emptyTitle}
      </h2>
      <p className="mx-auto mb-0 mt-2.5 max-w-[420px] text-[15.5px] leading-[1.6] text-ink-2">{CART_COPY.emptyBody}</p>
      <Button asChild className="mt-[22px] rounded-13 px-[22px] py-[13px] text-base leading-[normal]">
        <Link href="/software">{CART_COPY.browse}</Link>
      </Button>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-line-subtle py-5">
      <Skeleton className="size-[52px] flex-none rounded-[15px]" />
      <div className="grid min-w-0 flex-[1_1_220px] gap-2">
        <Skeleton className="h-[18px] w-3/5" />
        <Skeleton className="h-3.5 w-2/5" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <Skeleton className="h-5 w-[90px]" />
      <Skeleton className="size-[38px] rounded-[11px]" />
    </div>
  );
}

/** Loading layout: skeleton rows and summary, so the empty state never flashes before the cart is read. */
export function CartSkeleton({ rows = 2, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn(CART_GRID_CLASS, className)} aria-busy="true">
      <span className="sr-only" role="status">
        {CART_COPY.loading}
      </span>
      <div className={cn(CART_MAIN_SPAN_CLASS, "rounded-22 border border-line bg-surface px-6 py-2")}>
        {Array.from({ length: Math.max(1, Math.min(rows, 4)) }, (_, i) => (
          <SkeletonRow key={i} />
        ))}
        <div className="flex justify-between gap-3 py-[18px]">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-4 w-48" />
        </div>
      </div>
      <div className="grid gap-3 rounded-22 border border-line bg-surface p-6">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="mt-2 h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="mt-2 h-5 w-full" />
        <Skeleton className="mt-3 h-[54px] w-full rounded-14" />
      </div>
    </div>
  );
}
