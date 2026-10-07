"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { CardHeading, invalidProps, SECURITY_CARD, SECURITY_INPUT, SECURITY_SUBMIT, SecurityField } from "./security-parts";
import {
  firstError,
  PASSWORD_FIELDS,
  SECURITY_COPY,
  validatePasswordChange,
  type FieldErrors,
  type PasswordField,
  type PasswordValues,
} from "./security-model";

export type PasswordFormProps = {
  /** The account email (hidden username field, so password managers update the right entry). */
  email: string;
  /** After a change: the other sessions were signed out. */
  onChanged: () => void;
};

const IDS: Record<PasswordField, string> = { current: "password-current", next: "password-new", confirm: "password-confirm" };
const LABELS: Record<PasswordField, string> = {
  current: SECURITY_COPY.current,
  next: SECURITY_COPY.next,
  confirm: SECURITY_COPY.confirm,
};
const AUTOCOMPLETE: Record<PasswordField, string> = { current: "current-password", next: "new-password", confirm: "new-password" };
const EMPTY: PasswordValues = { current: "", next: "", confirm: "" };

/**
 * "Password" (prototype; novalidate): current, new and confirm. Client checks after the first submit follow the
 * fields live; a wrong current password shows under that field ("Your current password is incorrect."). Success
 * signs out the other sessions (decisions.md) and toasts "Password updated · other sessions signed out".
 */
export function PasswordForm({ email, onChanged }: PasswordFormProps) {
  const [values, setValues] = React.useState<PasswordValues>(EMPTY);
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<FieldErrors<PasswordField>>({});
  const [busy, setBusy] = React.useState(false);

  const clientErrors = tried ? validatePasswordChange(values) : {};
  const errors: FieldErrors<PasswordField> = { ...serverErrors, ...clientErrors };

  function set(field: PasswordField, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
    setServerErrors((prev) => (prev[field] ? { ...prev, [field]: undefined } : prev));
  }

  function focus(field: PasswordField | null) {
    if (field) window.requestAnimationFrame(() => document.getElementById(IDS[field])?.focus());
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const problems = validatePasswordChange(values);
    if (firstError(problems, PASSWORD_FIELDS)) {
      setTried(true);
      setServerErrors({});
      focus(firstError(problems, PASSWORD_FIELDS));
      return;
    }
    setBusy(true);
    try {
      await apiFetch<{ revokedSessions: number }>("/api/me/password", {
        method: "POST",
        body: { current: values.current, next: values.next },
      });
      setValues(EMPTY);
      setTried(false);
      setServerErrors({});
      toast.success(SECURITY_COPY.passwordUpdated);
      onChanged();
    } catch (error) {
      if (!(error instanceof ApiClientError)) {
        toast.error(UNEXPECTED_ERROR_MESSAGE);
        return;
      }
      const fields: FieldErrors<PasswordField> = {};
      const current = error.fieldErrors.current?.[0];
      const next = error.fieldErrors.next?.[0];
      if (current) fields.current = current;
      if (next) fields.next = next;
      if (firstError(fields, PASSWORD_FIELDS)) {
        setServerErrors(fields);
        focus(firstError(fields, PASSWORD_FIELDS));
      } else {
        toast.error(error.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form noValidate onSubmit={submit} aria-labelledby="security-password-heading" className={SECURITY_CARD}>
      <CardHeading id="security-password-heading">{SECURITY_COPY.passwordHeading}</CardHeading>
      <div className="grid gap-3 px-[18px] py-4">
        <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
        {PASSWORD_FIELDS.map((field) => (
          <SecurityField key={field} id={IDS[field]} label={LABELS[field]} error={errors[field]}>
            <input
              id={IDS[field]}
              type="password"
              autoComplete={AUTOCOMPLETE[field]}
              maxLength={1024}
              value={values[field]}
              onChange={(event) => set(field, event.target.value)}
              className={SECURITY_INPUT}
              {...invalidProps(IDS[field], errors[field])}
            />
          </SecurityField>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-line-subtle px-[18px] py-3">
        <span className="text-[12.5px] text-ink-2">{SECURITY_COPY.passwordNote}</span>
        <Button type="submit" loading={busy} className={SECURITY_SUBMIT}>
          {SECURITY_COPY.updatePassword}
        </Button>
      </div>
    </form>
  );
}
