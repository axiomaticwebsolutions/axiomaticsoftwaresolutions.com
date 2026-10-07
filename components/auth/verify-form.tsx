"use client";

import Link from "next/link";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { signInPath } from "@/lib/auth/redirect";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import {
  CODE_FIELDS,
  hasErrors,
  RESEND_COOLDOWN_SEC,
  retryAfterFrom,
  serverFieldErrors,
  validateCode,
  withNext,
  withoutCreatedFlag,
} from "./auth-model";
import {
  AuthErrorBanner,
  AuthErrorSummary,
  AuthFooter,
  AuthHeading,
  AuthNotice,
  AuthSubmit,
  CodeInput,
  leaveAuthPage,
} from "./auth-ui";
import { AUTH_COPY } from "./copy";
import { useCountdown } from "./use-countdown";

export type VerifyFormProps = {
  /** The signed-in user's email; null when signed out. */
  email: string | null;
  /** Safe path to continue to after verification. */
  next: string | null;
  /** Arrived from /register (?created=1): "Account created…" and a resend cooldown, since a code was just sent. */
  created: boolean;
};

const IDS = { code: "verify-code", summary: "verify-errors" } as const;

/** /verify (Account.dc.html mode "verify"): the emailed 6-digit code, with resend and its countdown. */
export function VerifyForm({ email, next, created }: VerifyFormProps) {
  const [signedOut, setSignedOut] = React.useState(email === null);
  const [code, setCode] = React.useState("");
  const [tried, setTried] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(created ? AUTH_COPY.register.created : null);
  const [busy, setBusy] = React.useState(false);
  const [resending, setResending] = React.useState(false);
  const [resendUntil, setResendUntil] = React.useState<number | null>(null);
  // Set when the per-user cap (hours) is hit: a new code would not help, so resend stays off.
  const [resendBlocked, setResendBlocked] = React.useState(false);
  const [focusRequest, setFocusRequest] = React.useState<{ id: string; at: number } | null>(null);
  const left = useCountdown(resendUntil);

  React.useEffect(() => {
    if (!created) return;
    setResendUntil(Date.now() + RESEND_COOLDOWN_SEC * 1000);
    // Show "Account created" once: a reload should not repeat it.
    window.history.replaceState(window.history.state, "", withoutCreatedFlag(`${window.location.pathname}${window.location.search}`));
  }, [created]);

  React.useEffect(() => {
    if (!focusRequest) return;
    const el = document.getElementById(focusRequest.id);
    el?.focus();
    if (el instanceof HTMLInputElement) el.select();
  }, [focusRequest]);

  if (signedOut) {
    return (
      <>
        <AuthHeading title={AUTH_COPY.verify.title} />
        <AuthErrorBanner>{AUTH_COPY.verify.signedOut}</AuthErrorBanner>
        <Button
          asChild
          size="lg"
          className="mt-[22px] h-[52px] w-full py-0 text-base font-extrabold shadow-none"
        >
          <Link href={signInPath(next)}>{AUTH_COPY.verify.signInCta}</Link>
        </Button>
        <AuthFooter
          items={[{ pre: AUTH_COPY.signIn.footerPre, label: AUTH_COPY.signIn.footerLink, href: withNext("/register", next) }]}
        />
      </>
    );
  }

  const fieldError = (tried ? validateCode(code).code : undefined) ?? serverError ?? undefined;
  const summary = fieldError ? [{ fieldId: IDS.code, message: fieldError }] : [];

  function handleError(err: unknown): boolean {
    if (!(err instanceof ApiClientError)) {
      setError(UNEXPECTED_ERROR_MESSAGE);
      return true;
    }
    if (err.status === 401) {
      setSignedOut(true);
      return true;
    }
    const rawWait = err.status === 429 ? Number(err.details.retryAfterSec) : Number.NaN;
    if (Number.isFinite(rawWait) && rawWait > 3600) {
      setResendBlocked(true);
      return false;
    }
    const wait = err.status === 429 ? retryAfterFrom(err.details) : null;
    if (wait) setResendUntil(Date.now() + wait * 1000);
    return false;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (hasErrors(validateCode(code))) {
      setTried(true);
      setServerError(null);
      setError(null);
      setFocusRequest({ id: IDS.summary, at: Date.now() });
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<{ redirectTo: string }>("/api/auth/verify-email", {
        method: "POST",
        body: { code, ...(next ? { next } : {}) },
      });
      leaveAuthPage(res.redirectTo);
    } catch (err) {
      setBusy(false);
      if (handleError(err) || !(err instanceof ApiClientError)) return;
      if (err.code === "validation_failed") {
        const fields = serverFieldErrors(err.fieldErrors, CODE_FIELDS);
        if (fields.code) {
          setServerError(fields.code);
          return setFocusRequest({ id: IDS.summary, at: Date.now() });
        }
      }
      setError(err.message);
      if (err.code === "invalid_code") setFocusRequest({ id: IDS.code, at: Date.now() });
    }
  }

  async function resend() {
    if (resending || left > 0 || resendBlocked) return;
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch<Record<string, never>>("/api/auth/resend-code", { method: "POST", body: {} });
      setResendUntil(Date.now() + RESEND_COOLDOWN_SEC * 1000);
      setCode("");
      setTried(false);
      setServerError(null);
      setNotice(AUTH_COPY.verify.resent);
    } catch (err) {
      if (!handleError(err) && err instanceof ApiClientError) setError(err.message);
    } finally {
      setResending(false);
    }
  }

  return (
    <>
      <AuthHeading title={AUTH_COPY.verify.title} subtitle={AUTH_COPY.verify.subtitle(email)} />
      {notice ? <AuthNotice>{notice}</AuthNotice> : null}
      {summary.length > 0 ? (
        <AuthErrorSummary id={IDS.summary} errors={summary} />
      ) : error ? (
        <AuthErrorBanner>{error}</AuthErrorBanner>
      ) : null}
      <form noValidate onSubmit={onSubmit} className="mt-[22px] grid gap-4">
        <Field id={IDS.code} label={AUTH_COPY.verify.code} error={fieldError}>
          <CodeInput
            name="code"
            value={code}
            onValueChange={(value) => {
              setCode(value);
              setServerError(null);
            }}
          />
        </Field>
        <AuthSubmit busy={busy}>{AUTH_COPY.verify.cta}</AuthSubmit>
      </form>
      <AuthFooter
        items={[
          {
            pre: AUTH_COPY.verify.resendPre,
            label: left > 0 ? AUTH_COPY.resendIn(left) : AUTH_COPY.verify.resend,
            onClick: () => void resend(),
            disabled: left > 0 || resending || resendBlocked,
          },
        ]}
      />
    </>
  );
}
