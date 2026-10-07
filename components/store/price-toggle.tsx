"use client";

import { useSyncExternalStore } from "react";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { DEFAULT_GST_RATE_PCT } from "@/lib/money";
import { readPriceMode, setPriceMode, subscribePriceMode, type PriceMode } from "@/lib/storefront/price-display";
import { cn } from "@/lib/utils";

export type PriceToggleProps = {
  /** GST rate in the "Incl. 18% GST" label (settings tax.gstRatePct). */
  ratePct?: number;
  className?: string;
};

const serverMode = (): PriceMode => "excl";

/**
 * "Excl. GST" / "Incl. 18% GST" segmented control (role="group", aria-pressed). Every toggle on the page follows
 * <html data-price>: the pressed look comes from CSS keyed on that attribute (app/globals.css), so it is right from
 * first paint, before hydration sets aria-pressed. Import it from components/store/price.tsx.
 */
export function PriceToggle({ ratePct = DEFAULT_GST_RATE_PCT, className }: PriceToggleProps) {
  const mode = useSyncExternalStore(subscribePriceMode, readPriceMode, serverMode);
  return (
    <SegmentedControl<PriceMode>
      aria-label="Price display"
      data-price-toggle=""
      // Prototype metrics: no gap between options, 18px lines (34px options in a 44px track).
      className={cn("gap-0 leading-[18px]", className)}
      value={mode}
      onValueChange={setPriceMode}
      options={[
        { value: "excl", label: "Excl. GST" },
        { value: "incl", label: `Incl. ${ratePct}% GST` },
      ]}
    />
  );
}
