"use client";

import type * as React from "react";
import { Dialog as SheetPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import { overlayClassName, useReturnFocus } from "@/components/ui/dialog";

/** Side drawer on Radix Dialog: focus trap, Escape and scrim close, focus returns to the trigger. */
export function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

export function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

export function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

const sheetVariants = cva(
  [
    "fixed z-50 flex flex-col bg-surface text-ink shadow-dialog outline-none",
    "duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
  ],
  {
    variants: {
      side: {
        // Admin detail drawer: 560px, slides 40px from the right in 200ms (README > Motion).
        right:
          "inset-y-0 right-0 h-dvh w-full max-w-[560px] border-l border-line data-[state=open]:slide-in-from-right-10 data-[state=closed]:slide-out-to-right-10",
        // Mobile nav / portal sidebar / catalog filters.
        left: "inset-y-0 left-0 h-dvh w-[calc(100%-48px)] max-w-[320px] border-r border-line data-[state=open]:slide-in-from-left-10 data-[state=closed]:slide-out-to-left-10",
      },
    },
    defaultVariants: { side: "right" },
  },
);

export type SheetContentProps = React.ComponentProps<typeof SheetPrimitive.Content> &
  VariantProps<typeof sheetVariants> & {
    /** Renders a top-right Close button. Turn off when SheetHeader supplies its own. */
    showClose?: boolean;
  };

export function SheetContent({
  className,
  children,
  side,
  showClose = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: SheetContentProps) {
  const focus = useReturnFocus(onOpenAutoFocus, onCloseAutoFocus);
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay data-slot="sheet-overlay" className={overlayClassName} />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        className={cn(sheetVariants({ side }), className)}
        {...focus}
        {...props}
      >
        {/* First in the DOM so it takes initial focus instead of the first footer action. */}
        {showClose ? (
          <SheetPrimitive.Close
            className="absolute right-3 top-3 z-10 grid size-9 cursor-pointer place-items-center rounded-10 text-ink-2 transition-colors hover:bg-slate-bg hover:text-ink"
            aria-label="Close"
          >
            <Icon name="close" size={20} />
          </SheetPrimitive.Close>
        ) : null}
        {children}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("grid gap-1 border-b border-line-subtle px-5 py-4 pr-14", className)}
      {...props}
    />
  );
}

/** Scrollable middle of the drawer. */
export function SheetBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-body" className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", className)} {...props} />;
}

export function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("flex flex-wrap justify-end gap-2 border-t border-line-subtle px-5 py-3.5", className)}
      {...props}
    />
  );
}

export function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-[18px] font-extrabold leading-snug tracking-[-0.01em]", className)}
      {...props}
    />
  );
}

export function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-[13.5px] text-ink-2", className)}
      {...props}
    />
  );
}
