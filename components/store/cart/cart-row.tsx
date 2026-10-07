"use client";

import Link from "next/link";
import type * as React from "react";
import { Icon } from "@/components/icons/icon";
import { TONE_TILE_CLASSES } from "@/components/store/active-nav";
import { QuantityStepper } from "@/components/ui/quantity-stepper";
import { signInPath } from "@/lib/auth/redirect";
import { formatINR } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { CartRow as CartRowModel } from "./cart-model";

export type CartRowProps = {
  row: CartRowModel;
  onQtyChange: (key: string, qty: number) => void;
  onRemove: (key: string) => void;
  /** Ref of the remove button (focus moves to a neighbour's after a removal). */
  removeRef?: React.Ref<HTMLButtonElement>;
  /** Where "Sign in" returns to for lines that need an account. */
  signInNext: string;
};

/**
 * One cart line (Cart.dc.html): tinted product tile, product link, "{plan} · {limits}", unit line, an optional
 * terminals stepper, the amount and a delete button. Lines the server refused show its message and keep only Remove.
 */
export function CartRowItem({ row, onQtyChange, onRemove, removeRef, signInNext }: CartRowProps) {
  const nameClass = "text-[16.5px] font-extrabold text-ink no-underline";
  return (
    <div data-cart-row={row.key} className="flex flex-wrap items-center gap-4 border-b border-line-subtle py-5">
      <span
        aria-hidden="true"
        className={cn("grid size-[52px] flex-none place-items-center rounded-[15px]", TONE_TILE_CLASSES[row.tone])}
      >
        <Icon name={row.icon} size={26} />
      </span>
      <div className="min-w-0 flex-[1_1_220px]">
        {row.href ? (
          <Link href={row.href} className={cn(nameClass, "rounded-6 hover:text-primary-link")}>
            {row.productName}
          </Link>
        ) : (
          <span className={nameClass}>{row.productName}</span>
        )}
        <div className="mt-[3px] text-[14.5px] font-semibold text-ink-2">
          {row.planName} · {row.limits}
        </div>
        <div className="mt-[3px] text-[13.5px] text-ink-2">{row.unitLine}</div>
        {row.issue ? (
          <p className="mb-0 mt-2 flex items-start gap-1.5 text-[13.5px] font-semibold leading-[1.45] text-danger">
            <Icon name="error" size={17} className="mt-px" />
            <span>
              {row.issue.message}
              {row.issue.code === "sign_in_required" ? (
                <>
                  {" "}
                  <Link href={signInPath(signInNext)} className="rounded-6 font-bold text-primary-link hover:text-primary-link-hover">
                    Sign in
                  </Link>
                </>
              ) : null}
            </span>
          </p>
        ) : null}
      </div>
      {row.stepper && !row.issue ? (
        <QuantityStepper
          size="sm"
          value={row.qty}
          min={1}
          max={row.stepper.max}
          label={row.stepper.label}
          onValueChange={(qty) => onQtyChange(row.key, qty)}
        />
      ) : null}
      {row.amountPaise !== null ? (
        // ml-auto: when the controls wrap under the text on phones, amount and delete stay on the right.
        <div className="tabular ml-auto text-right text-[17px] font-extrabold sm:min-w-[110px]">{formatINR(row.amountPaise)}</div>
      ) : null}
      <button
        ref={removeRef}
        type="button"
        aria-label={row.removeLabel}
        onClick={() => onRemove(row.key)}
        className="grid size-[38px] flex-none cursor-pointer place-items-center rounded-[11px] border border-line bg-surface text-danger transition-colors hover:bg-pink-bg"
      >
        <Icon name="delete" size={20} />
      </button>
    </div>
  );
}
