"use client";

import type * as React from "react";
import { Icon } from "@/components/icons/icon";
import { TONE_TILE_CLASSES } from "@/components/store/active-nav";
import { ratePctLabel, type CartRow } from "@/components/store/cart/cart-model";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import type { QuoteDto } from "@/lib/checkout/quote";
import { formatINR } from "@/lib/money";
import { gstSplit } from "@/lib/pricing";
import { cn } from "@/lib/utils";
import { CHECKOUT_COPY, isIntraState, taxNote } from "./checkout-form";

export type CouponView =
  | { mode: "input"; value: string; error: string | null; applying: boolean }
  | { mode: "applied"; code: string; label: string };

export type OrderSummaryProps = {
  rows: readonly CartRow[] | null;
  quote: QuoteDto | null;
  /** False while a newer quote is loading (values are dimmed and marked busy). */
  current: boolean;
  quoteError: string | null;
  onRetryQuote: () => void;
  state: string;
  companyState: string;
  coupon: CouponView;
  onCouponInput: (value: string) => void;
  onApplyCoupon: () => void;
  onRemoveCoupon: () => void;
  showSampleCodes: boolean;
  onRemoveLine: (key: string) => void;
  busy: boolean;
  /** False when no payment provider is configured: Pay is disabled (the form shows why). */
  paymentsAvailable?: boolean;
  couponInputRef?: React.Ref<HTMLInputElement>;
  couponRemoveRef?: React.Ref<HTMLButtonElement>;
};

const MINUS = "\u2212";

/** Focus lands here after a refused line is removed (its Remove button disappears). */
export const ORDER_SUMMARY_HEADING_ID = "checkout-summary-h";

/**
 * The sticky "Order summary" (Checkout.dc.html): lines, coupon, Subtotal / Discount / Taxable value / CGST + SGST or
 * IGST / Total, the tax note, the Pay button and the payment note. Server prices; the CGST/SGST vs IGST split follows
 * the selected state at once (same rule as the server, decisions.md 3) without another request.
 */
export function OrderSummary(props: OrderSummaryProps) {
  const { rows, quote, current, state, companyState, busy } = props;
  const ready = rows !== null && quote !== null;
  const intra = isIntraState(state, companyState);
  const split = quote ? gstSplit(quote.taxablePaise, quote.gstRatePct, intra) : null;
  const totalPaise = quote && split ? quote.taxablePaise + split.gstPaise : null;
  const rate = quote ? quote.gstRatePct : 18;
  const half = ratePctLabel(rate / 2);
  const taxLines =
    split === null
      ? []
      : intra
        ? [
            { label: `CGST ${half}%`, paise: split.cgstPaise },
            { label: `SGST ${half}%`, paise: split.sgstPaise },
          ]
        : [{ label: `IGST ${ratePctLabel(rate)}%`, paise: split.igstPaise }];
  const discounted = props.coupon.mode === "applied" && quote !== null && quote.discountPaise > 0;
  const dt = "font-semibold text-ink-2";
  const dd = "m-0 text-right font-bold";

  return (
    <aside
      aria-label={CHECKOUT_COPY.orderSummary}
      className="min-w-0 rounded-22 border border-line bg-surface p-6 min-[70rem]:sticky min-[70rem]:top-5"
    >
      <h2 id={ORDER_SUMMARY_HEADING_ID} tabIndex={-1} className="m-0 text-[18px] font-extrabold outline-none">
        {CHECKOUT_COPY.orderSummary}
      </h2>
      {ready ? (
        <div className="mt-3.5 grid gap-3">
          {rows.map((row) => (
            <SummaryLine key={row.key} row={row} onRemove={props.onRemoveLine} />
          ))}
        </div>
      ) : (
        <div className="mt-3.5 grid gap-3" aria-hidden="true">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-start gap-3">
              <Skeleton className="size-[38px] rounded-[11px]" />
              <div className="grid flex-1 gap-1.5">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
              <Skeleton className="h-4 w-14" />
            </div>
          ))}
        </div>
      )}
      <div className="mt-[18px] border-t border-line-subtle pt-4">
        <CouponBox {...props} />
      </div>
      {props.quoteError ? (
        <Alert tone="danger" className="mt-4">
          <span className="font-semibold text-ink-body">{props.quoteError}</span>
          <Button type="button" variant="secondary" size="sm" onClick={props.onRetryQuote} className="mt-2 justify-self-start">
            Try again
          </Button>
        </Alert>
      ) : null}
      {quote && split && totalPaise !== null ? (
        <dl
          aria-busy={!current || undefined}
          className={cn(
            "tabular mb-0 mt-[18px] grid grid-cols-[1fr_auto] gap-y-[9px] text-[14.5px] transition-opacity",
            // 85%: dimmed while re-pricing (or after a failed quote) yet still 4.5:1 for the secondary text.
            !current && "opacity-85",
          )}
        >
          <dt className={dt}>{CHECKOUT_COPY.subtotal}</dt>
          <dd className={dd}>{formatINR(quote.subtotalPaise)}</dd>
          {discounted ? (
            <>
              <dt className="font-bold text-sage-fg">{CHECKOUT_COPY.discount}</dt>
              <dd className={cn(dd, "text-sage-fg")}>
                {MINUS}
                {formatINR(quote.discountPaise)}
              </dd>
            </>
          ) : null}
          <dt className={dt}>{CHECKOUT_COPY.taxable}</dt>
          <dd className={dd}>{formatINR(quote.taxablePaise)}</dd>
          {taxLines.map((line) => (
            <TaxRow key={line.label} label={line.label} paise={line.paise} dt={dt} dd={dd} />
          ))}
          <dt className="border-t border-line-subtle pt-3 text-[18px] font-extrabold">{CHECKOUT_COPY.total}</dt>
          <dd className="m-0 border-t border-line-subtle pt-3 text-right text-[18px] font-extrabold">{formatINR(totalPaise)}</dd>
        </dl>
      ) : (
        <div className="mt-[18px] grid gap-2.5" aria-hidden="true">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="mt-2 h-5 w-full" />
        </div>
      )}
      <p className="mb-0 mt-2 text-[12.5px] text-ink-2">{taxNote(state, companyState)}</p>
      <Button
        type="submit"
        size="lg"
        loading={busy}
        loadingText={CHECKOUT_COPY.creating}
        disabled={!ready || totalPaise === null || props.paymentsAvailable === false}
        className="mt-[18px] h-[54px] w-full gap-2.5 py-0 text-base font-extrabold leading-[normal] shadow-none aria-disabled:opacity-100"
      >
        {totalPaise === null ? CHECKOUT_COPY.pay("").trim() : CHECKOUT_COPY.pay(formatINR(totalPaise))}
      </Button>
      <p className="mb-0 mt-3 flex gap-1.5 text-[13px] leading-[1.5] text-ink-2">
        <Icon name="verified_user" size={17} className="mt-px text-sage-fg" />
        {CHECKOUT_COPY.payNote}
      </p>
    </aside>
  );
}

function TaxRow({ label, paise, dt, dd }: { label: string; paise: number; dt: string; dd: string }) {
  return (
    <>
      <dt className={dt}>{label}</dt>
      <dd className={dd}>{formatINR(paise)}</dd>
    </>
  );
}

/** One order line: 38px tile, short name, "{plan} × {qty}", amount; refused lines show why and a Remove action. */
function SummaryLine({ row, onRemove }: { row: CartRow; onRemove: (key: string) => void }) {
  return (
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className={cn("grid size-[38px] flex-none place-items-center rounded-[11px]", TONE_TILE_CLASSES[row.tone])}>
        <Icon name={row.icon} size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[14.5px] font-bold">{row.shortName}</div>
        <div className="text-[13px] font-semibold text-ink-2">
          {row.planName}
          {row.qty > 1 ? ` × ${row.qty}` : ""}
        </div>
        {row.issue ? (
          <div className="mt-1 grid gap-1">
            <FieldError className="text-[13px] leading-[1.4]">{row.issue.message}</FieldError>
            <button
              type="button"
              onClick={() => onRemove(row.key)}
              aria-label={row.removeLabel}
              className="cursor-pointer justify-self-start rounded-6 border-0 bg-transparent p-0 text-[13px] font-bold text-primary-link underline hover:text-primary-link-hover"
            >
              {CHECKOUT_COPY.remove}
            </button>
          </div>
        ) : null}
      </div>
      {row.amountPaise !== null && !row.issue ? (
        <div className="tabular text-[14.5px] font-bold">{formatINR(row.amountPaise)}</div>
      ) : null}
    </div>
  );
}

function CouponBox(props: OrderSummaryProps) {
  const { coupon } = props;
  if (coupon.mode === "applied") {
    return (
      <div role="status" className="flex items-center gap-2.5 rounded-12 bg-sage-bg px-3 py-2.5 text-[14px] font-bold text-sage-fg">
        <Icon name="sell" size={19} />
        <span className="min-w-0 flex-1">{CHECKOUT_COPY.couponApplied(coupon.code, coupon.label)}</span>
        <button
          ref={props.couponRemoveRef}
          type="button"
          onClick={props.onRemoveCoupon}
          aria-label={`${CHECKOUT_COPY.remove} coupon ${coupon.code}`}
          className="cursor-pointer rounded-6 border-0 bg-transparent p-0 font-extrabold text-sage-fg underline"
        >
          {CHECKOUT_COPY.remove}
        </button>
      </div>
    );
  }
  const errorId = "checkout-coupon-error";
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor="checkout-coupon">{CHECKOUT_COPY.couponLabel}</Label>
        <div className="flex gap-2">
          <Input
            ref={props.couponInputRef}
            id="checkout-coupon"
            name="coupon"
            value={coupon.value}
            onChange={(event) => props.onCouponInput(event.target.value)}
            onKeyDown={(event) => {
              // Enter applies the code instead of submitting the order.
              if (event.key === "Enter") {
                event.preventDefault();
                props.onApplyCoupon();
              }
            }}
            maxLength={40}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            placeholder={CHECKOUT_COPY.couponPlaceholder}
            aria-invalid={coupon.error ? true : undefined}
            aria-describedby={coupon.error ? errorId : undefined}
            mono
            className="h-11 flex-1 rounded-[11px] px-3 text-[14px] font-medium uppercase"
          />
          <Button
            type="button"
            variant="secondary"
            onClick={props.onApplyCoupon}
            loading={coupon.applying}
            className="h-11 rounded-[11px] px-4 py-0 text-[15px] leading-[normal]"
          >
            {CHECKOUT_COPY.apply}
          </Button>
        </div>
        {coupon.error ? (
          <FieldError id={errorId} role="alert" className="text-[13px]">
            {coupon.error}
          </FieldError>
        ) : null}
      </div>
      {props.showSampleCodes ? <div className="mt-1.5 text-[12.5px] text-ink-2">{CHECKOUT_COPY.sampleCodes}</div> : null}
    </>
  );
}
