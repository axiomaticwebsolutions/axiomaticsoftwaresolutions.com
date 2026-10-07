"use client";

import * as React from "react";
import { Field, type FormError } from "@/components/ui/field";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { FORGOT_FIELDS, hasErrors, serverFieldErrors, validateForgot, type FieldErrorMap, type ForgotField } from "./auth-model";
import { AuthErrorBanner, AuthErrorSummary, AuthFooter, AuthHeading, AuthInput, AuthNotice, AuthSubmit } from "./auth-ui";
import { AUTH_COPY } from "./copy";

const IDS = { email: "forgot-email", summary: "forgot-errors" } as const;

/**
 * /forgot (Account.dc.html mode "forgot"). The API answers the same for every address, so the confirmation never
 * says whether an account exists. Unlike the prototype (which jumped to the reset form), the page stays here: the
 * link arrives by email.
 */
export function ForgotForm({ initialEmail }: { initialEmail: string }) {
  const [email, setEmail] = React.useState(initialEmail);
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<FieldErrorMap<ForgotField>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [focusRequest, setFocusRequest] = React.useState<{ id: string; at: number } | null>(null);

  React.useEffect(() => {
    if (focusRequest) document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);

  const message = (tried ? validateForgot({ email }).email : undefined) ?? serverErrors.email;
  const summary: FormError[] = message ? [{ fieldId: IDS.email, message }] : [];

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (hasErrors(validateForgot({ email }))) {
      setTried(true);
      setServerErrors({});
      setError(null);
      setSentTo(null);
      setFocusRequest({ id: IDS.summary, at: Date.now() });
      return;
    }
    setBusy(true);
    setError(null);
    setSentTo(null);
    const address = email.trim().toLowerCase();
    try {
      await apiFetch<Record<string, never>>("/api/auth/forgot-password", { method: "POST", body: { email: address } });
      setSentTo(address);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "validation_failed") {
        const fields = serverFieldErrors(err.fieldErrors, FORGOT_FIELDS);
        if (fields.email) {
          setServerErrors(fields);
          setTried(true);
          setFocusRequest({ id: IDS.summary, at: Date.now() });
          return;
        }
      }
      setError(err instanceof ApiClientError ? err.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <AuthHeading title={AUTH_COPY.forgot.title} subtitle={AUTH_COPY.forgot.subtitle} />
      {sentTo ? <AuthNotice>{AUTH_COPY.forgot.sent(sentTo)}</AuthNotice> : null}
      {summary.length > 0 ? (
        <AuthErrorSummary id={IDS.summary} errors={summary} />
      ) : error ? (
        <AuthErrorBanner>{error}</AuthErrorBanner>
      ) : null}
      <form noValidate onSubmit={onSubmit} className="mt-[22px] grid gap-4">
        <Field id={IDS.email} label={AUTH_COPY.forgot.email} error={message}>
          <AuthInput
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            autoCapitalize="none"
            maxLength={254}
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setServerErrors({});
            }}
          />
        </Field>
        <AuthSubmit busy={busy}>{AUTH_COPY.forgot.cta}</AuthSubmit>
      </form>
      <AuthFooter items={[{ pre: AUTH_COPY.forgot.footerPre, label: AUTH_COPY.forgot.footerLink, href: "/sign-in" }]} />
    </>
  );
}
