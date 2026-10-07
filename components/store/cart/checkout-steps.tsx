import { cn } from "@/lib/utils";

const STEPS = ["Cart", "Details", "Payment"] as const;

export type CheckoutStepsProps = { current?: 1 | 2 | 3; className?: string };

/**
 * "1 Cart — 2 Details — 3 Payment" pills (Cart.dc.html). An ordered list with aria-current="step" on the current
 * step; the dashes are decorative. Server-safe.
 */
export function CheckoutSteps({ current = 1, className }: CheckoutStepsProps) {
  return (
    <ol
      aria-label="Checkout steps"
      className={cn("m-0 flex list-none flex-wrap items-center gap-1.5 p-0 text-[13.5px] font-bold text-ink-2", className)}
    >
      {STEPS.map((label, index) => {
        const step = index + 1;
        const active = step === current;
        return (
          <li key={label} className="flex items-center gap-1.5" aria-current={active ? "step" : undefined}>
            {index > 0 ? <span aria-hidden="true">—</span> : null}
            <span className={cn("rounded-pill px-3 py-1.5", active ? "bg-primary text-white" : "bg-slate-bg")}>
              {step} {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
