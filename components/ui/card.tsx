import type * as React from "react";
import * as Slot from "radix-ui/slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const cardVariants = cva("flex flex-col rounded-20 border border-line bg-surface text-ink", {
  variants: {
    interactive: {
      // Link cards (one stretched link inside): hover lifts with the card shadow and an accent border; keyboard
      // focus on the link draws the focus ring around the whole card, so the link itself may drop its outline.
      true: [
        "transition-[box-shadow,border-color] duration-200 hover:border-primary-accent hover:shadow-card-hover",
        "has-focus-visible:border-primary has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-primary",
      ],
      false: "",
    },
  },
  defaultVariants: { interactive: false },
});

/** Card: white, 1px line border, radius 20, no shadow at rest (README > Shadows). Server-safe. */
export function Card({ className, interactive, ...props }: React.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return <div data-slot="card" className={cn(cardVariants({ interactive }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-header" className={cn("grid gap-1.5 px-6 pt-6", className)} {...props} />;
}

/** Card title; renders an h3 unless asChild wraps your own heading element. */
export function CardTitle({ className, asChild = false, ...props }: React.ComponentProps<"h3"> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "h3";
  return (
    <Comp
      data-slot="card-title"
      className={cn("text-[18px] font-extrabold leading-snug tracking-[-0.01em]", className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="card-description" className={cn("text-[14.5px] text-ink-2", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="card-content" className={cn("px-6 py-5", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="card-footer" className={cn("mt-auto flex flex-wrap items-center gap-3 px-6 pb-6", className)} {...props} />
  );
}
