"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import { returnFocusTarget } from "@/components/ui/return-focus";

export function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export function DialogPortal(props: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

export function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

type AutoFocusHandler = (event: Event) => void;

/**
 * Returns focus to whatever was focused before the overlay opened. Radix only restores focus to its own Trigger,
 * so overlays opened from state (a table row, a menu item, a toolbar button) would otherwise drop focus on <body>.
 * A menu item opener is replaced by its menu's trigger (see returnFocusTarget).
 * Shared by DialogContent, AlertDialogContent and SheetContent; caller handlers run first and can preventDefault.
 */
export function useReturnFocus(onOpenAutoFocus?: AutoFocusHandler, onCloseAutoFocus?: AutoFocusHandler) {
  const previous = React.useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: (event: Event) => {
      // Fires before Radix moves focus inside, so activeElement is still the opener.
      previous.current = returnFocusTarget(document.activeElement);
      onOpenAutoFocus?.(event);
    },
    onCloseAutoFocus: (event: Event) => {
      onCloseAutoFocus?.(event);
      const target = previous.current;
      previous.current = null;
      if (event.defaultPrevented || !target || !target.isConnected) return;
      event.preventDefault();
      target.focus();
    },
  };
}

/** Scrim shared by Dialog, AlertDialog and Sheet: ink at 50%. */
export const overlayClassName =
  "fixed inset-0 z-50 bg-ink/50 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0";

export function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return <DialogPrimitive.Overlay data-slot="dialog-overlay" className={cn(overlayClassName, className)} {...props} />;
}

/** Centered panel classes shared with AlertDialog (radius 16, dialog shadow, 16px gutter on phones). */
export const dialogPanelClassName = cn(
  "fixed left-1/2 top-1/2 z-50 grid max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] max-w-[520px] -translate-x-1/2 -translate-y-1/2",
  "gap-4 overflow-y-auto rounded-16 bg-surface p-5 text-ink shadow-dialog sm:p-6",
  "duration-200 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:slide-in-from-bottom-2",
  "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
);

export type DialogContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** Renders the top-right close button (Escape and the scrim always close). */
  showClose?: boolean;
};

export function DialogContent({
  className,
  children,
  showClose = true,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: DialogContentProps) {
  const focus = useReturnFocus(onOpenAutoFocus, onCloseAutoFocus);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(dialogPanelClassName, className)}
        {...focus}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            className="absolute right-3 top-3 grid size-9 cursor-pointer place-items-center rounded-10 text-ink-2 transition-colors hover:bg-slate-bg hover:text-ink"
            aria-label="Close"
          >
            <Icon name="close" size={20} />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("grid gap-1.5 pr-8", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-[18px] font-extrabold leading-snug tracking-[-0.01em]", className)}
      {...props}
    />
  );
}

export function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-[14.5px] leading-relaxed text-ink-2", className)}
      {...props}
    />
  );
}
