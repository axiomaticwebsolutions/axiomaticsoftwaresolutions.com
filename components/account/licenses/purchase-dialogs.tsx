"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Price, TaxNote } from "@/components/store/price";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { addLicenseLines, CART_FAILED_MESSAGE, CART_FULL_MESSAGE, CART_PATH } from "./cart";
import type { LicenseDetailData, PaidPlanChoice } from "./data";
import { intervalUnit, type CartLineSpec } from "./model";
import { PortalDialog } from "./portal-dialog";

/** Adds license lines to the cart and opens it (prototype: renewals and add-ons go straight to the cart). */
export function useAddLicenseLines(): (lines: readonly CartLineSpec[]) => boolean {
  const router = useRouter();
  return React.useCallback(
    (lines: readonly CartLineSpec[]) => {
      const result = addLicenseLines(lines);
      if (result.added === 0) {
        toast.error(result.full ? CART_FULL_MESSAGE : CART_FAILED_MESSAGE);
        return false;
      }
      router.push(CART_PATH);
      return true;
    },
    [router],
  );
}

const MAX_CHOICES = 10;

/** "Add computers to {LIC}" (prototype): quantity select, then an ADDON line for this license. */
export function AddComputersDialog({
  open,
  onOpenChange,
  licenseId,
  addon,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  licenseId: string;
  addon: NonNullable<LicenseDetailData["addon"]>;
}) {
  const add = useAddLicenseLines();
  const selectId = React.useId();
  const [qty, setQty] = React.useState(1);
  const choices = Array.from({ length: Math.max(1, Math.min(addon.maxQty, MAX_CHOICES)) }, (_, i) => i + 1);
  return (
    <PortalDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQty(1);
        onOpenChange(next);
      }}
      title={`Add computers to ${licenseId}`}
      description={
        <>
          Each extra computer costs <Price paise={addon.unitPricePaise} /> <TaxNote /> and stays with this license for its term.
        </>
      }
      confirmLabel="Add to cart"
      onConfirm={() => {
        if (add([{ planId: addon.planId, qty, maxQty: Math.max(qty, addon.maxQty), kind: "ADDON", targetLicenseId: licenseId }])) {
          onOpenChange(false);
        }
      }}
    >
      <div className="mt-3.5 flex items-center justify-between gap-3">
        <label htmlFor={selectId} className="text-[13.5px] font-bold">
          Computers to add
        </label>
        <select
          id={selectId}
          value={qty}
          onChange={(event) => setQty(Number(event.target.value))}
          className="h-10 cursor-pointer rounded-10 border border-line-input bg-surface px-2.5 text-[14px] font-bold text-ink focus-visible:border-primary focus-visible:shadow-focus focus-visible:outline-hidden"
        >
          {choices.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </div>
    </PortalDialog>
  );
}

function planUnit(plan: PaidPlanChoice): string {
  const unit = intervalUnit(plan.interval);
  return plan.perUnit ? `${unit} per ${plan.perUnit}` : unit;
}

/**
 * A trial's "Buy a license" / "Choose plan": the product's paid plans; the chosen one goes to the cart as an
 * UPGRADE of the trial license, which keeps its key, devices and data (decisions.md rule 6). New UI: the prototype
 * sent people to the product page, whose plans would buy a second license.
 */
export function ChoosePlanDialog({
  open,
  onOpenChange,
  license,
  plans,
  defaultPlanId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  license: { id: string; productShortName: string };
  plans: readonly PaidPlanChoice[];
  defaultPlanId?: string;
}) {
  const add = useAddLicenseLines();
  const labelId = React.useId();
  const initial = plans.find((p) => p.planId === defaultPlanId)?.planId ?? plans[0]?.planId ?? "";
  const [planId, setPlanId] = React.useState(initial);
  const chosen = plans.find((p) => p.planId === planId);
  return (
    <PortalDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPlanId(initial);
        onOpenChange(next);
      }}
      title={`Buy a license for ${license.productShortName}`}
      description={`Pick a plan. ${license.id} keeps its key, devices and data when it becomes a paid license.`}
      confirmLabel="Add to cart"
      confirmDisabled={!chosen}
      onConfirm={() => {
        if (chosen && add([chosen.line])) onOpenChange(false);
      }}
    >
      <p id={labelId} className="sr-only">
        Plan
      </p>
      <RadioGroup aria-labelledby={labelId} value={planId} onValueChange={setPlanId} className="mt-3.5 gap-2">
        {plans.map((plan) => {
          const id = `${labelId}-${plan.planId}`;
          return (
            <label
              key={plan.planId}
              htmlFor={id}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-12 border px-3.5 py-3 transition-colors",
                plan.planId === planId ? "border-primary bg-lavender-soft" : "border-line-alt hover:border-line-input",
              )}
            >
              <RadioGroupItem id={id} value={plan.planId} />
              <span className="min-w-0 flex-1 text-[14px] font-extrabold">{plan.name}</span>
              <span className="whitespace-nowrap text-right text-[14px] font-extrabold">
                <Price paise={plan.unitPricePaise} />{" "}
                <span className="text-[12.5px] font-semibold text-ink-2">
                  <TaxNote excl={`${planUnit(plan)} + GST`} incl={`${planUnit(plan)} incl. GST`} />
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </PortalDialog>
  );
}
