"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "@/components/icons/icon";
import { Button, type ButtonVariant } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type ConfirmTone = "danger" | "warning" | "primary" | "success";

export type ConfirmResult = { reason: string };

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  /** What happens if the user confirms (the consequence). */
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
  icon?: IconName;
  /** Require a reason for the audit log (default true). */
  requireReason?: boolean;
  /** Minimum trimmed reason length (default 4, as in the admin console). */
  minReasonLength?: number;
  /** When set, the user must type this exact value (e.g. the license or order ID) to enable the confirm button. */
  confirmText?: string;
  /**
   * Runs on confirm. A returned promise keeps the dialog open with a busy button; it closes when the promise
   * resolves. A thrown Error's message is shown inline and the dialog stays open.
   */
  onConfirm: (result: ConfirmResult) => void | Promise<void>;
  /** An error to show inline, e.g. from a server action the parent ran. */
  error?: React.ReactNode;
};

const TONES: Record<ConfirmTone, { tile: string; button: ButtonVariant; icon: IconName }> = {
  danger: { tile: "bg-pink-bg text-pink-fg", button: "destructive", icon: "error" },
  warning: { tile: "bg-peach-bg text-peach-fg", button: "warning", icon: "warning" },
  primary: { tile: "bg-lavender-bg text-lavender-fg", button: "primary", icon: "info" },
  success: { tile: "bg-sage-bg text-sage-fg", button: "primary", icon: "check_circle" },
};

const REASON_LABEL = "Reason (saved to the audit log)";
const REASON_ERROR = "Add a short reason for the audit log.";
const FALLBACK_ERROR = "Something went wrong. Try again.";

/**
 * Destructive or audited confirmation (admin "ask" dialog): tone icon tile, title, consequence, optional reason
 * and typed-ID check, inline error, Cancel + coloured confirm. Confirm stays disabled until the inputs are valid.
 */
export function ConfirmDialog({ open, onOpenChange, ...props }: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Escape and Cancel are ignored while the action runs, so its outcome is never hidden.
        if (!pending) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        {/* Content unmounts on close, so the form state below starts fresh every time the dialog opens. */}
        <ConfirmForm {...props} pending={pending} setPending={setPending} close={() => onOpenChange(false)} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

type ConfirmFormProps = Omit<ConfirmDialogProps, "open" | "onOpenChange"> & {
  pending: boolean;
  setPending: (pending: boolean) => void;
  close: () => void;
};

function ConfirmForm({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "danger",
  icon,
  requireReason = true,
  minReasonLength = 4,
  confirmText,
  onConfirm,
  error,
  pending,
  setPending,
  close,
}: ConfirmFormProps) {
  const id = React.useId();
  const [reason, setReason] = React.useState("");
  const [typed, setTyped] = React.useState("");
  const [touched, setTouched] = React.useState({ reason: false, typed: false });
  const [runError, setRunError] = React.useState<string | null>(null);

  const reasonOk = !requireReason || reason.trim().length >= minReasonLength;
  const typedOk = confirmText === undefined || typed.trim() === confirmText;
  const valid = reasonOk && typedOk;
  const style = TONES[tone];

  const reasonError = requireReason && touched.reason && !reasonOk ? REASON_ERROR : null;
  const typedError =
    confirmText !== undefined && touched.typed && typed.length > 0 && !typedOk
      ? `Type ${confirmText} exactly to confirm.`
      : null;
  const shownError = runError ?? error;

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // React events bubble through the portal: without this, confirming a dialog opened inside another form (e.g. the
    // category editor's "Delete category") would also submit that form.
    event.stopPropagation();
    if (!valid || pending) return;
    setRunError(null);
    const result: ConfirmResult = { reason: requireReason ? reason.trim() : "" };
    try {
      const maybe = onConfirm(result);
      if (maybe instanceof Promise) {
        setPending(true);
        await maybe;
      }
      setPending(false);
      close();
    } catch (cause) {
      setPending(false);
      setRunError(cause instanceof Error && cause.message ? cause.message : FALLBACK_ERROR);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4" noValidate>
      <div className="flex gap-3">
        <span aria-hidden="true" className={cn("grid size-[38px] shrink-0 place-items-center rounded-10", style.tile)}>
          <Icon name={icon ?? style.icon} size={21} />
        </span>
        <div className="grid min-w-0 gap-1.5">
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </div>
      </div>

      {requireReason ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-reason`} size="sm">
            {REASON_LABEL}
          </Label>
          <Textarea
            id={`${id}-reason`}
            size="sm"
            rows={2}
            value={reason}
            required
            aria-invalid={reasonError ? true : undefined}
            aria-describedby={reasonError ? `${id}-reason-error` : undefined}
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, reason: true }))}
          />
          {reasonError ? (
            <p id={`${id}-reason-error`} className="text-[13px] font-semibold text-danger">
              {reasonError}
            </p>
          ) : null}
        </div>
      ) : null}

      {confirmText !== undefined ? (
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-typed`} size="sm" className="flex-wrap gap-1">
            Type <code className="font-mono text-danger">{confirmText}</code> to confirm
          </Label>
          <Input
            id={`${id}-typed`}
            size="sm"
            mono
            value={typed}
            required
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={typedError ? true : undefined}
            aria-describedby={typedError ? `${id}-typed-error` : undefined}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={() => setTouched((t) => ({ ...t, typed: true }))}
          />
          {typedError ? (
            <p id={`${id}-typed-error`} className="text-[13px] font-semibold text-danger">
              {typedError}
            </p>
          ) : null}
        </div>
      ) : null}

      {shownError ? (
        <div role="alert" className="rounded-8 bg-pink-bg px-2.5 py-2 text-[13px] font-bold text-danger">
          {shownError}
        </div>
      ) : null}

      <AlertDialogFooter>
        <AlertDialogCancel disabled={pending}>{cancelLabel}</AlertDialogCancel>
        <Button type="submit" size="sm" variant={style.button} disabled={!valid} loading={pending}>
          {confirmLabel}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}
