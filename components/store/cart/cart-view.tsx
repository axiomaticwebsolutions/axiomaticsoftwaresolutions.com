"use client";

import Link from "next/link";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useCart } from "@/lib/cart/use-cart";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import { buildCartRows, cartTotals, ratePctLabel, toRequestItems, type CartPlanCatalog } from "./cart-model";
import { CartRowItem } from "./cart-row";
import { CART_COPY, CART_GRID_CLASS, CART_MAIN_SPAN_CLASS, CartSkeleton, EmptyCart } from "./cart-states";
import { useQuote } from "./use-quote";

export type CartViewProps = {
  /** Plan details for the rows (toCartPlanCatalog of the published catalog). */
  catalog: CartPlanCatalog;
};

/**
 * /cart body below the title (Cart.dc.html): the items panel and the summary, the empty state, or skeletons while the
 * stored cart is read and first priced. Prices come from POST /api/checkout/quote; quantity changes preview at once
 * and re-quote after a short pause. Every tab follows the same cart (lib/cart/store.ts).
 */
export function CartView({ catalog }: CartViewProps) {
  const cart = useCart();
  const items = cart.items;
  const body = React.useMemo(() => ({ items: toRequestItems(items) }), [items]);
  const quote = useQuote(body, { enabled: cart.ready && items.length > 0 });
  const rows = React.useMemo(() => buildCartRows(items, quote.data, catalog), [items, quote.data, catalog]);

  const removeRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const emptyHeadingRef = React.useRef<HTMLHeadingElement>(null);
  /** After a removal: the neighbouring line to focus, or "" for the empty-state heading. */
  const pendingFocus = React.useRef<string | null>(null);
  const [announcement, setAnnouncement] = React.useState("");

  React.useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === "") emptyHeadingRef.current?.focus();
    else removeRefs.current.get(target)?.focus();
  }, [items]);

  const onRemove = React.useCallback(
    (key: string) => {
      const index = items.findIndex((i) => i.key === key);
      const neighbour = items[index + 1] ?? items[index - 1];
      const label = rows?.find((r) => r.key === key)?.removeLabel;
      cart.remove(key);
      if (label) setAnnouncement(CART_COPY.removed(label));
      pendingFocus.current = neighbour ? neighbour.key : "";
    },
    [cart, items, rows],
  );

  const live = (
    <p className="sr-only" role="status" aria-live="polite">
      {announcement}
    </p>
  );

  if (!cart.ready) return <CartSkeleton rows={2} />;
  if (items.length === 0) {
    return (
      <>
        {live}
        <EmptyCart headingRef={emptyHeadingRef} />
      </>
    );
  }
  if (!rows || !quote.data) {
    if (quote.error) {
      return (
        <div className="mt-7">
          <Alert tone="danger">
            <span className="font-semibold text-ink-body">{quote.error.message}</span>
            <Button type="button" variant="secondary" size="sm" onClick={quote.retry} className="mt-2 justify-self-start">
              {CART_COPY.tryAgain}
            </Button>
          </Alert>
        </div>
      );
    }
    return <CartSkeleton rows={items.length} />;
  }

  const totals = cartTotals(rows, quote.data, quote.current);
  const busy = !quote.current;

  return (
    <>
      {live}
      {quote.error ? (
        <Alert tone="danger" className="mt-7">
          <span className="font-semibold text-ink-body">{quote.error.message}</span>
          <Button type="button" variant="secondary" size="sm" onClick={quote.retry} className="mt-2 justify-self-start">
            {CART_COPY.tryAgain}
          </Button>
        </Alert>
      ) : null}
      <div className={CART_GRID_CLASS}>
        <section aria-label="Items" className={cn(CART_MAIN_SPAN_CLASS, "rounded-22 border border-line bg-surface px-6 py-2")}>
          {rows.map((row) => (
            <CartRowItem
              key={row.key}
              row={row}
              onQtyChange={cart.setQty}
              onRemove={onRemove}
              signInNext="/cart"
              removeRef={(el) => {
                if (el) removeRefs.current.set(row.key, el);
                else removeRefs.current.delete(row.key);
              }}
            />
          ))}
          <div className="flex flex-wrap justify-between gap-3 py-[18px]">
            <Link href="/software" className="rounded-6 font-bold text-primary-link no-underline hover:text-primary-link-hover">
              {CART_COPY.continueShopping}
            </Link>
            <span className="text-[14px] font-semibold text-ink-2">{CART_COPY.couponsAtCheckout}</span>
          </div>
        </section>
        <aside
          aria-label="Summary"
          className="sticky top-[calc(var(--store-header-h,108px)+24px)] rounded-22 border border-line bg-surface p-6"
        >
          <h2 className="m-0 text-[19px] font-extrabold">{CART_COPY.summary}</h2>
          <dl
            aria-busy={busy || undefined}
            className={cn(
              "tabular mb-0 mt-[18px] grid grid-cols-[1fr_auto] gap-y-2.5 text-[15px] transition-opacity",
              // 85%: dimmed while re-pricing (or after a failed quote) yet still 4.5:1 for the secondary text.
              busy && "opacity-85",
            )}
          >
            <dt className="font-semibold text-ink-2">{CART_COPY.subtotal}</dt>
            <dd className="m-0 text-right font-bold">{formatINR(totals.subtotalPaise)}</dd>
            <dt className="font-semibold text-ink-2">{CART_COPY.gst(ratePctLabel(totals.gstRatePct))}</dt>
            <dd className="m-0 text-right font-bold">{formatINR(totals.gstPaise)}</dd>
            <dt className="border-t border-line-subtle pt-3 text-[17px] font-extrabold">{CART_COPY.estimatedTotal}</dt>
            <dd className="m-0 border-t border-line-subtle pt-3 text-right text-[17px] font-extrabold">
              {formatINR(totals.totalPaise)}
            </dd>
          </dl>
          <p className="mb-0 mt-3 text-[13px] leading-[1.55] text-ink-2">{CART_COPY.taxNote}</p>
          {/* A full page load on purpose: only /checkout and /orders/:id send the CSP that allows Razorpay Checkout.js
              (next.config.ts), and a client-side navigation would keep this page's stricter policy. */}
          <a
            href="/checkout"
            className="mt-[18px] block rounded-14 bg-primary p-[15px] text-center font-extrabold text-white no-underline transition-colors hover:bg-primary-hover hover:text-white"
          >
            {CART_COPY.continueToCheckout}
          </a>
          <p className="mb-0 mt-3.5 flex items-start gap-1.5 text-[13px] text-ink-2">
            <Icon name="lock" size={17} />
            {CART_COPY.guestNote}
          </p>
        </aside>
      </div>
    </>
  );
}
