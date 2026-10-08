"use client";

import * as React from "react";
import { Icon } from "@/components/icons/icon";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { INTEGRATIONS_COPY } from "@/lib/admin/settings/integrations-model";
import { UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";

/**
 * What the action behind the dialog answered:
 * - done: close (focus returns to the button that opened it);
 * - password: stay open, the message under the password field (wrong password, empty);
 * - error: stay open, the message in an alert (rate limited, settings changed meanwhile, network);
 * - close: close and run `focus` instead of returning focus (field errors in the card).
 */
export type PasswordOutcome =
  | { status: "done" }
  | { status: "password"; message: string }
  | { status: "error"; message: string }
  | { status: "close"; focus?: () => void };

export type PasswordDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The consequence ("Payment provider changes for everyone within 30 seconds."). */
  description: React.ReactNode;
  confirmLabel: string;
  tone?: "primary" | "danger";
  onConfirm: (password: string) => Promise<PasswordOutcome>;
};

/**
 * "Confirm with your password" (admin AlertDialog styles of components/ui/confirm-dialog.tsx) for Save, Clear and
 * Remove in Admin > Settings > Integrations. One password field (current-password), focused on open; its error stays
 * in the dialog, tied to the field. Enter submits; Cancel and Escape close and return focus to the trigger. The
 * password lives only in this dialog's state, which unmounts on close.
 */
export function PasswordDialog({ open, onOpenChange, ...props }: PasswordDialogProps) {
  const inputId = `${React.useId()}-password`;
  const [pending, setPending] = React.useState(false);
  const focusAfterClose = React.useRef<(() => void) | null>(null);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Escape and Cancel are ignored while the request runs, so its outcome is never hidden.
        if (!pending) onOpenChange(next);
      }}
    >
      <AlertDialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          document.getElementById(inputId)?.focus();
        }}
        onCloseAutoFocus={(event) => {
          const focus = focusAfterClose.current;
          focusAfterClose.current = null;
          if (focus) {
            event.preventDefault();
            focus();
          }
        }}
      >
        <PasswordForm
          {...props}
          inputId={inputId}
          pending={pending}
          setPending={setPending}
          close={(focus) => {
            focusAfterClose.current = focus ?? null;
            onOpenChange(false);
          }}
        />
      </AlertDialogContent>
    </AlertDialog>
  );
}

type PasswordFormProps = Omit<PasswordDialogProps, "open" | "onOpenChange"> & {
  inputId: string;
  pending: boolean;
  setPending: (pending: boolean) => void;
  close: (focus?: () => void) => void;
};

function PasswordForm({ description, confirmLabel, tone = "primary", onConfirm, inputId, pending, setPending, close }: PasswordFormProps) {
  const [password, setPassword] = React.useState("");
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const errorId = `${inputId}-error`;
  const focusInput = () => window.requestAnimationFrame(() => document.getElementById(inputId)?.focus());

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // The dialog renders in a portal, but React events still bubble to the card's form: never submit that one too.
    event.stopPropagation();
    if (pending) return;
    if (password === "") {
      setFieldError(INTEGRATIONS_COPY.dialog.empty);
      focusInput();
      return;
    }
    setFieldError(null);
    setFormError(null);
    setPending(true);
    let outcome: PasswordOutcome;
    try {
      outcome = await onConfirm(password);
    } catch (error) {
      outcome = { status: "error", message: error instanceof Error && error.message ? error.message : UNEXPECTED_ERROR_MESSAGE };
    }
    setPending(false);
    if (outcome.status === "done") close();
    else if (outcome.status === "close") close(outcome.focus);
    else if (outcome.status === "password") {
      setPassword("");
      setFieldError(outcome.message);
      focusInput();
    } else setFormError(outcome.message);
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <div className="flex gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-[38px] shrink-0 place-items-center rounded-10",
            tone === "danger" ? "bg-pink-bg text-pink-fg" : "bg-lavender-bg text-lavender-fg",
          )}
        >
          <Icon name="lock" size={21} />
        </span>
        <div className="grid min-w-0 gap-1.5">
          <AlertDialogTitle>{INTEGRATIONS_COPY.dialog.title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor={inputId} size="sm">
          {INTEGRATIONS_COPY.dialog.label}
        </Label>
        <Input
          id={inputId}
          size="sm"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={fieldError ? true : undefined}
          aria-describedby={fieldError ? errorId : undefined}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (fieldError) setFieldError(null);
          }}
        />
        {fieldError ? <FieldError id={errorId}>{fieldError}</FieldError> : null}
      </div>

      {formError ? (
        <div role="alert" className="rounded-8 bg-pink-bg px-2.5 py-2 text-[13px] font-bold text-danger">
          {formError}
        </div>
      ) : null}

      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>{INTEGRATIONS_COPY.dialog.cancel}</AlertDialogCancel>
        <Button type="submit" size="sm" variant={tone === "danger" ? "destructive" : "primary"} loading={pending}>
          {confirmLabel}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}
