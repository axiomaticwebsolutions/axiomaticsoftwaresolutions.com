"use client";

import Link from "next/link";
import * as React from "react";
import { saveSignInPrefill } from "@/components/store/order/session-keys";
import { Button } from "@/components/ui/button";
import { type FormError } from "@/components/ui/field";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import {
  hasErrors,
  RESET_FIELDS,
  serverFieldErrors,
  validateReset,
  type FieldErrorMap,
  type ResetField,
} from "./auth-model";
import { AuthErrorBanner, AuthErrorSummary, AuthFooter, AuthHeading, AuthSubmit, leaveAuthPage } from "./auth-ui";
import { AUTH_COPY, resetFormCopy } from "./copy";
import { NewPasswordField } from "./new-password-field";

const FIELD_IDS: Record<ResetField, string> = { password: "reset-password", confirm: "reset-confirm" };
const SUMMARY_ID = "reset-errors";
const TOKEN_ERRORS = new Set(["token_invalid", "token_expired"]);

export type ResetFormProps = {
  token: string;
  /** The account the link belongs to ("For {email}."). */
  email: string;
  /** "set": the account has no password yet (staff-issued set-password link), so the page reads "Set your password". */
  mode?: "set" | "reset";
};

/**
 * /reset?token=… (Account.dc.html mode "reset"; "Set your password" for an account without one). Success sends the
 * user to /sign-in?reset=1 with the account email kept (prototype: only the password fields are cleared), handed over
 * in sessionStorage, never in the URL.
 */
export function ResetForm({ token, email, mode = "reset" }: ResetFormProps) {
  const copy = resetFormCopy(mode);
  const [values, setValues] = React.useState<Record<ResetField, string>>({ password: "", confirm: "" });
  const [showPassword, setShowPassword] = React.useState(false);
  const [showConfirm, setShowConfirm] = React.useState(false);
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<FieldErrorMap<ResetField>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [linkError, setLinkError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [focusRequest, setFocusRequest] = React.useState<{ id: string; at: number } | null>(null);

  React.useEffect(() => {
    if (focusRequest) document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);

  if (linkError) return <ResetLinkProblem message={linkError} />;

  const clientErrors = tried ? validateReset(values) : {};
  const errors: FieldErrorMap<ResetField> = {};
  for (const key of RESET_FIELDS) {
    const message = clientErrors[key] ?? serverErrors[key];
    if (message) errors[key] = message;
  }
  const summary: FormError[] = RESET_FIELDS.flatMap((key) => {
    const message = errors[key];
    return message ? [{ fieldId: FIELD_IDS[key], message }] : [];
  });

  function set(key: ResetField, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setServerErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setShowPassword(false);
    setShowConfirm(false);
    if (hasErrors(validateReset(values))) {
      setTried(true);
      setServerErrors({});
      setError(null);
      setFocusRequest({ id: SUMMARY_ID, at: Date.now() });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ redirectTo: string }>("/api/auth/reset-password", {
        method: "POST",
        body: { token, password: values.password },
      });
      saveSignInPrefill(email);
      leaveAuthPage(res.redirectTo, "/sign-in?reset=1");
    } catch (err) {
      setBusy(false);
      if (!(err instanceof ApiClientError)) return setError(UNEXPECTED_ERROR_MESSAGE);
      if (TOKEN_ERRORS.has(err.code)) return setLinkError(err.message);
      if (err.code === "validation_failed") {
        const fields = serverFieldErrors(err.fieldErrors, ["password"] as const);
        if (fields.password) {
          setServerErrors(fields);
          setTried(true);
          return setFocusRequest({ id: SUMMARY_ID, at: Date.now() });
        }
      }
      setError(err.message);
    }
  }

  return (
    <>
      <AuthHeading title={copy.title} subtitle={copy.subtitle(email)} />
      {summary.length > 0 ? (
        <AuthErrorSummary id={SUMMARY_ID} errors={summary} />
      ) : error ? (
        <AuthErrorBanner>{error}</AuthErrorBanner>
      ) : null}
      <form noValidate onSubmit={onSubmit} className="mt-[22px] grid gap-4">
        {/* Lets password managers file the new password under the right account. */}
        <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
        <NewPasswordField
          id={FIELD_IDS.password}
          label={copy.password}
          value={values.password}
          onChange={(value) => set("password", value)}
          error={errors.password}
          visible={showPassword}
          onVisibleChange={setShowPassword}
        />
        <NewPasswordField
          id={FIELD_IDS.confirm}
          name="confirm-password"
          label={AUTH_COPY.reset.confirm}
          value={values.confirm}
          onChange={(value) => set("confirm", value)}
          error={errors.confirm}
          visible={showConfirm}
          onVisibleChange={setShowConfirm}
          showStrength={false}
        />
        <AuthSubmit busy={busy}>{copy.cta}</AuthSubmit>
      </form>
      <AuthFooter items={[{ label: AUTH_COPY.reset.back, href: "/sign-in" }]} />
    </>
  );
}

/** Unknown, used or expired reset link (new state): the API's message and a way to ask for a new link. */
export function ResetLinkProblem({ message }: { message: string }) {
  return (
    <>
      <AuthHeading title={AUTH_COPY.reset.title} subtitle={AUTH_COPY.reset.invalidSubtitle} />
      <AuthErrorBanner>{message}</AuthErrorBanner>
      <Button asChild size="lg" className="mt-[22px] h-[52px] w-full py-0 text-base font-extrabold shadow-none">
        <Link href="/forgot">{AUTH_COPY.reset.requestNew}</Link>
      </Button>
      <AuthFooter items={[{ label: AUTH_COPY.reset.back, href: "/sign-in" }]} />
    </>
  );
}
