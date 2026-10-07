"use client";

import * as React from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ApiClientError, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";

export type PortalConfirmTone = "danger" | "primary";

export type PortalConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: PortalConfirmTone;
  /** Ask for the account password (prototype dialog "Password" field), e.g. turning two-step off. */
  password?: boolean;
  passwordLabel?: string;
  /**
   * Runs on confirm. Resolving closes the dialog; a thrown error keeps it open and shows its message (an
   * ApiClientError's server message, else a generic one) in the pink alert.
   */
  onConfirm: (input: { password: string }) => void | Promise<void>;
  /**
   * Where focus goes on close when the element that opened the dialog is gone (e.g. the row that was removed).
   * Without it, or when the opener is still there, focus returns to the opener.
   */
  fallbackFocus?: () => HTMLElement | null;
};

/** Prototype dialog buttons: 10x16px, radius 10, 16px/700. */
export const DIALOG_BUTTON_CLASS = "h-auto rounded-10 px-4 py-2.5 text-[16px] font-bold leading-[normal]";

/**
 * The portal's confirmation dialog (Customer Portal.dc.html generic modal; Radix AlertDialog for the focus trap):
 * title 18px/800, body 14.5px, an optional password field, an inline error, Cancel and a primary or danger action.
 * Escape and Cancel close it, except while the action runs; focus returns to the opener.
 */
export function PortalConfirmDialog({ open, onOpenChange, fallbackFocus, ...props }: PortalConfirmDialogProps) {
  const [pending, setPending] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const openerRef = React.useRef<Element | null>(null);
  const withPassword = props.password ?? false;
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) onOpenChange(next);
      }}
    >
      <AlertDialogContent
        className="max-w-[460px] gap-0 rounded-18 p-[22px] leading-[normal] sm:p-[22px]"
        onOpenAutoFocus={(event) => {
          openerRef.current = document.activeElement;
          // AlertDialog focuses Cancel by default; with a password field, start there instead.
          if (!withPassword) return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const opener = openerRef.current;
          openerRef.current = null;
          if (opener?.isConnected) return;
          const target = fallbackFocus?.();
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        {/* Content unmounts on close, so the password and error start empty every time. */}
        <ConfirmBody {...props} inputRef={inputRef} pending={pending} setPending={setPending} close={() => onOpenChange(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

type BodyProps = Omit<PortalConfirmDialogProps, "open" | "onOpenChange"> & {
  inputRef: React.RefObject<HTMLInputElement | null>;
  pending: boolean;
  setPending: (pending: boolean) => void;
  close: () => void;
};

function ConfirmBody({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  password = false,
  passwordLabel = "Password",
  onConfirm,
  inputRef,
  pending,
  setPending,
  close,
}: BodyProps) {
  const id = React.useId();
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [fieldError, setFieldError] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (password && value === "") {
      setError("Enter your password.");
      setFieldError(true);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setFieldError(false);
    try {
      const result = onConfirm({ password: value });
      if (result instanceof Promise) {
        setPending(true);
        await result;
      }
      setPending(false);
      close();
    } catch (cause) {
      setPending(false);
      const message = cause instanceof Error && cause.message ? cause.message : UNEXPECTED_ERROR_MESSAGE;
      setError(message);
      const passwordProblem = password && cause instanceof ApiClientError && Boolean(cause.fieldErrors.password?.length);
      setFieldError(passwordProblem);
      if (passwordProblem) {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
  }

  return (
    <form noValidate onSubmit={submit}>
      <AlertDialogTitle className="text-[18px] font-extrabold leading-[normal]">{title}</AlertDialogTitle>
      <AlertDialogDescription className="mt-2 text-[14.5px] leading-[1.6] text-ink-2">{description}</AlertDialogDescription>
      {password ? (
        <div className="mt-3.5 grid gap-1.5">
          <label htmlFor={`${id}-password`} className="text-[13.5px] font-bold">
            {passwordLabel}
          </label>
          <input
            ref={inputRef}
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-invalid={fieldError || undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            className="field-focus h-[42px] w-full rounded-10 border border-line-input bg-surface px-3 text-[15px] font-semibold text-ink aria-invalid:border-danger-border"
          />
        </div>
      ) : null}
      {error ? (
        <div
          id={`${id}-error`}
          role="alert"
          className="mt-3 rounded-10 bg-pink-bg px-3 py-2.5 text-[13.5px] font-bold text-danger"
        >
          {error}
        </div>
      ) : null}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <AlertDialogCancel disabled={pending} className={cn(DIALOG_BUTTON_CLASS, "border-line-input")}>
          {cancelLabel}
        </AlertDialogCancel>
        <Button
          type="submit"
          variant={tone === "danger" ? "destructive" : "primary"}
          loading={pending}
          className={DIALOG_BUTTON_CLASS}
        >
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}
