import type * as React from "react";
import * as Slot from "radix-ui/slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1 whitespace-nowrap rounded-pill font-extrabold leading-snug",
  {
    variants: {
      tone: {
        lavender: "bg-lavender-bg text-lavender-fg",
        sage: "bg-sage-bg text-sage-fg",
        blue: "bg-blue-bg text-blue-fg",
        peach: "bg-peach-bg text-peach-fg",
        pink: "bg-pink-bg text-pink-fg",
        slate: "bg-slate-bg text-slate-fg",
        outline: "border border-line-input bg-surface text-ink-2",
        // "Most chosen" plan tag and count badges.
        primary: "bg-primary text-primary-foreground",
      },
      size: {
        sm: "px-2 py-0.5 text-[11.5px]",
        md: "px-3 py-[5px] text-[12.5px]",
      },
    },
    defaultVariants: { tone: "slate", size: "md" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean };

/** Pill badge in a tone (README colour table: every fg/bg pair meets 4.5:1). Server-safe. */
export function Badge({ className, tone, size, asChild = false, ...props }: BadgeProps) {
  const Comp = asChild ? Slot.Root : "span";
  return <Comp data-slot="badge" className={cn(badgeVariants({ tone, size }), className)} {...props} />;
}
