"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { returnFocusTarget } from "@/components/ui/return-focus";
import { cn } from "@/lib/utils";

export type PortalDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description: React.ReactNode;
  /** Fields between the description and the error (password, quantity...). */
  children?: React.ReactNode;
  /** Shown in the pink alert box (role="alert"), e.g. the server's message. */
  error?: React.ReactNode;
  confirmLabel: React.ReactNode;
  cancelLabel?: string;
  /** primary (lavender) or danger (red) confirm button; danger dialogs are alert dialogs. */
  tone?: "primary" | "danger";
  /** Runs on confirm (form submit, so Enter in a field confirms too). */
  onConfirm: () => void;
  busy?: boolean;
  confirmDisabled?: boolean;
  /**
   * Where focus goes on close when the element that opened the dialog is gone (its row was removed, the bulk bar
   * closed). Without it, or while the opener is still there, focus returns to the opener.
   */
  fallbackFocus?: () => HTMLElement | null;
  /** Runs when the dialog has closed, before focus returns; preventDefault() and focus another element to override. */
  onCloseAutoFocus?: (event: Event) => void;
  className?: string;
};

const FOOTER_BUTTON = "rounded-10 px-4 py-2.5 text-[16px] leading-[normal]";

/**
 * The portal prototype's dialog: 460px, radius 18, 22px padding, 18px/800 title, 14.5px description, a pink error
 * box, and Cancel + a coloured confirm on the right. Escape, the scrim and Cancel close it (not while busy); focus
 * moves into the dialog and returns to the opener.
 */
export function PortalDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  error,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "primary",
  onConfirm,
  busy = false,
  confirmDisabled = false,
  fallbackFocus,
  onCloseAutoFocus,
  className,
}: PortalDialogProps) {
  const openerRef = React.useRef<HTMLElement | null>(null);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy && !confirmDisabled) onConfirm();
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (busy ? undefined : onOpenChange(next))}>
      <DialogContent
        showClose={false}
        role={tone === "danger" ? "alertdialog" : "dialog"}
        onOpenAutoFocus={() => {
          openerRef.current = returnFocusTarget(document.activeElement);
        }}
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current;
          openerRef.current = null;
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented || opener?.isConnected) return;
          const target = fallbackFocus?.();
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
        className={cn("block max-w-[460px] rounded-18 p-[22px] leading-[normal] sm:p-[22px]", className)}
      >
        <form onSubmit={submit} noValidate>
          <DialogTitle className="m-0 text-[18px] font-extrabold leading-[normal] tracking-normal">{title}</DialogTitle>
          <DialogDescription className="mb-0 mt-2 text-[14.5px] leading-[1.6] text-ink-2">{description}</DialogDescription>
          {children}
          {error ? (
            <div role="alert" className="mt-3 rounded-10 bg-pink-bg px-3 py-2.5 text-[13.5px] font-bold text-danger">
              {error}
            </div>
          ) : null}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" className={FOOTER_BUTTON} onClick={() => onOpenChange(false)} disabled={busy}>
              {cancelLabel}
            </Button>
            <Button
              type="submit"
              variant={tone === "danger" ? "destructive" : "primary"}
              className={FOOTER_BUTTON}
              loading={busy}
              disabled={confirmDisabled}
            >
              {confirmLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Field label in dialogs: 13.5px/700 above a 42px control (prototype). */
export const DIALOG_LABEL = "mt-3.5 grid gap-1.5 text-[13.5px] font-bold";
export const DIALOG_INPUT =
  "h-[42px] w-full rounded-10 border border-line-input bg-surface px-3 text-[14px] font-semibold text-ink transition-[border-color,box-shadow] duration-150 focus-visible:border-primary focus-visible:shadow-focus focus-visible:outline-hidden aria-invalid:border-danger-border";
