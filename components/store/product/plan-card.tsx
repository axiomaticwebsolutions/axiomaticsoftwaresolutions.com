"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Icon } from "@/components/icons/icon";
import { Price, PriceVariants } from "@/components/store/price";
import { Button } from "@/components/ui/button";
import { QuantityStepper } from "@/components/ui/quantity-stepper";
import { toast } from "@/components/ui/sonner";
import { VisuallyHidden } from "@/components/ui/visually-hidden";
import { cartLineKey } from "@/lib/cart/store";
import { useCart } from "@/lib/cart/use-cart";
import type { Tone } from "@/lib/design/tokens";
import { maxQtyFor, planTypeTag, planUnitLabel, trialHref } from "@/lib/storefront/derive";
import type { StorePlan } from "@/lib/storefront/types";
import { cn } from "@/lib/utils";
import { showCartToast } from "./cart-toast";
import { PRODUCT_COPY } from "./copy";
import { cartToastDetail, perUnitCopy } from "./model";
import { PRODUCT_TONES } from "./tones";

export type PlanCardProps = {
  plan: StorePlan;
  productSlug: string;
  productShortName: string;
  tone: Tone;
  ratePct: number;
};

const CTA = "mt-[18px] h-12 w-full rounded-13 px-4 py-0 text-[15px] leading-[normal]";

/**
 * Plan card (prototype `plans`): type tag, name, summary, price for the chosen quantity, tax line, inclusions, a
 * quantity stepper for per-unit plans (1..maxQty, default 10) and the CTA: "Start free trial" for trials, otherwise
 * "Add to cart" (client cart + the product toast). The most chosen plan gets a 2px primary border and a filled CTA.
 */
export function PlanCard({ plan, productSlug, productShortName, tone, ratePct }: PlanCardProps) {
  const cart = useCart();
  const [qty, setQty] = useState(1);
  const labelId = useId();
  const isTrial = plan.type === "TRIAL";
  const max = maxQtyFor(plan);
  const perUnit = plan.perUnit ? perUnitCopy(plan.perUnit) : null;
  const tagClasses = isTrial ? "bg-sage-bg text-sage-fg" : PRODUCT_TONES[tone].tile;

  const addToCart = () => {
    const key = cartLineKey({ kind: "NEW", planId: plan.id, targetLicenseId: null });
    const before = cart.items.find((item) => item.key === key)?.qty ?? 0;
    const result = cart.add(plan.id, { qty, maxQty: max });
    if (!result.ok) {
      toast.error(result.reason === "full" ? PRODUCT_COPY.cartFull : PRODUCT_COPY.cartInvalid);
      return;
    }
    const unchanged = result.capped && result.item.qty === before;
    showCartToast({
      title: unchanged ? PRODUCT_COPY.toastAlreadyInCart : PRODUCT_COPY.toastAdded,
      detail: cartToastDetail(productShortName, plan.name, unchanged ? result.item.qty : qty),
    });
  };

  return (
    <div
      className={cn(
        "relative flex flex-col rounded-22 bg-surface p-[26px]",
        plan.popular ? "border-2 border-primary" : "border border-line",
      )}
    >
      {plan.popular ? (
        <span className="absolute -top-3 left-6 rounded-pill bg-primary px-3 py-1 text-[12px] font-extrabold text-white">
          {PRODUCT_COPY.mostChosen}
        </span>
      ) : null}
      <span
        className={cn("self-start rounded-8 px-2.5 py-1 text-[12px] font-extrabold tracking-[0.06em]", tagClasses)}
      >
        {planTypeTag(plan)}
      </span>
      <h3 className="m-0 mt-3.5 text-[20px] font-extrabold">{plan.name}</h3>
      {plan.summary ? (
        <p className="m-0 mt-1.5 min-h-11 text-[14.5px] leading-[1.55] text-ink-2">{plan.summary}</p>
      ) : null}
      <p className="m-0 mt-4 flex flex-wrap items-baseline gap-1.5">
        {isTrial ? (
          <span className="text-[30px] font-extrabold tracking-[-0.03em]">{PRODUCT_COPY.free}</span>
        ) : (
          <Price
            paise={plan.pricePaise}
            qty={qty}
            ratePct={ratePct}
            className="text-[30px] font-extrabold tracking-[-0.03em]"
          />
        )}
        <span className="text-[14px] font-semibold text-ink-2">{planUnitLabel(plan, qty)}</span>
      </p>
      <p className="m-0 mt-0.5 text-[13px] font-semibold text-ink-2">
        {isTrial ? (
          PRODUCT_COPY.noPaymentNeeded
        ) : (
          <PriceVariants excl={PRODUCT_COPY.taxLineExcl(ratePct)} incl={PRODUCT_COPY.taxLineIncl(ratePct)} />
        )}
      </p>
      <ul className="m-0 mt-[18px] grid flex-1 list-none gap-[9px] p-0 text-[14.5px] font-semibold">
        {plan.includes.map((item) => (
          <li key={item} className="flex gap-[9px]">
            <Icon name="check" size={19} className="my-0.5 text-success" />
            {item}
          </li>
        ))}
      </ul>
      {perUnit ? (
        <div className="mt-[18px] flex items-center justify-between gap-2.5 text-[14px] font-bold">
          <span id={labelId}>{perUnit.label}</span>
          <QuantityStepper
            aria-labelledby={labelId}
            value={qty}
            onValueChange={setQty}
            min={1}
            max={max}
            decrementLabel={perUnit.fewer}
            incrementLabel={perUnit.more}
          />
        </div>
      ) : null}
      {isTrial ? (
        <Button asChild variant={plan.popular ? "primary" : "secondary"} className={CTA}>
          <Link href={trialHref(productSlug)}>
            {PRODUCT_COPY.startTrial}
            <VisuallyHidden>: {plan.name}</VisuallyHidden>
          </Link>
        </Button>
      ) : (
        <Button
          type="button"
          variant={plan.popular ? "primary" : "secondary"}
          className={CTA}
          onClick={addToCart}
        >
          {PRODUCT_COPY.addToCart}
          <VisuallyHidden>: {plan.name}</VisuallyHidden>
        </Button>
      )}
    </div>
  );
}
