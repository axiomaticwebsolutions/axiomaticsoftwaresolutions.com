"use client";

import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { STORE_PATHS } from "@/components/store/active-nav";
import { useCart } from "@/lib/cart/use-cart";
import { cn } from "@/lib/utils";

/** "Cart, 2 items" (the prototype never singularised; "1 item" reads better). */
export function cartLabel(count: number): string {
  return `Cart, ${count} ${count === 1 ? "item" : "items"}`;
}

export type CartButtonProps = {
  className?: string;
  /** Extra click handler (the mobile panel closes itself). */
  onClick?: () => void;
};

/**
 * 42px cart link with the live item count (sum of quantities) in a primary pill at the bag's top-right corner: 19px
 * tall and at least 19px wide, including its 2px bg ring (border-box, as on the composed prototype pages: about 21x19
 * for one digit). The cart lives in localStorage, so the count is 0 on the server and fills in after mount; the
 * link's accessible name carries the count.
 */
export function CartButton({ className, onClick }: CartButtonProps) {
  const { count } = useCart();
  return (
    <Link
      href={STORE_PATHS.cart}
      aria-label={cartLabel(count)}
      onClick={onClick}
      className={cn(
        "relative grid size-[42px] shrink-0 place-items-center rounded-12 text-ink no-underline transition-colors hover:bg-lavender-bg",
        className,
      )}
    >
      <Icon name="shopping_bag" size={23} />
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="absolute right-0.5 top-[3px] grid h-[19px] min-w-[19px] place-items-center rounded-pill border-2 border-bg bg-primary px-[5px] text-[11.5px] font-extrabold leading-none text-white tabular"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
    </Link>
  );
}
