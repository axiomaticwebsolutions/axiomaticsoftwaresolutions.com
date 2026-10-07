"use client";

import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import {
  hasErrors,
  RESEND_COOLDOWN_SEC,
  retryAfterFrom,
  serverFieldErrors,
  CODE_FIELDS,
  validateCode,
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

export type LoginChallenge = { challengeId: string; emailHint: string; sentAt: number };

type SignInAgainResponse =
  | { requires2fa: false; redirectTo: string }
  | { requires2fa: true; challengeId: string; emailHint: string };

export type TwoStepStepProps = {
  initialChallenge: LoginChallenge;
  /** Kept from the password step so "Resend code" can sign in again for a fresh code. */
  credentials: { email: string; password: string; next: string | null };
  /** Back to the password step: with a message when the challenge is over (expired, used up), null when chosen. */
  onBack: (message: string | null) => void;
};

const IDS = { code: "two-step-code", trust: "two-step-trust", trustHint: "two-step-trust-hint", subtitle: "two-step-subtitle", summary: "two-step-errors" } as const;

/** These end the challenge: the user signs in again (the API's copy says so). */
const CHALLENGE_OVER = new Set(["code_expired", "too_many_attempts", "invalid_credentials"]);

/**
 * Two-step sign-in (new; the prototype has no design for it): the emailed 6-digit code, "Trust this device for 30
 * days", resend with a cooldown, and a way back to the password step.
 */
export function TwoStepStep({ initialChallenge, credentials, onBack }: TwoStepStepProps) {
  const [challenge, setChallenge] = React.useState(initialChallenge);
  const [code, setCode] = React.useState("");
  const [trust, setTrust] = React.useState(false);
  const [tried, setTried] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [resending, setResending] = React.useState(false);
  const [resendUntil, setResendUntil] = React.useState<number>(initialChallenge.sentAt + RESEND_COOLDOWN_SEC * 1000);
  const [focusRequest, setFocusRequest] = React.useState<{ id: string; at: number }>({ id: IDS.code, at: 0 });
  const left = useCountdown(resendUntil);

  React.useEffect(() => {
    const el = document.getElementById(focusRequest.id);
    el?.focus();
    if (el instanceof HTMLInputElement && focusRequest.at > 0) el.select();
  }, [focusRequest]);

  const fieldError = (tried ? validateCode(code).code : undefined) ?? serverError ?? undefined;
  const summary = fieldError ? [{ fieldId: IDS.code, message: fieldError }] : [];

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
      const res = await apiFetch<{ redirectTo: string }>("/api/auth/sign-in/verify", {
        method: "POST",
        body: { challengeId: challenge.challengeId, code, trustDevice: trust },
      });
      leaveAuthPage(res.redirectTo);
    } catch (err) {
      setBusy(false);
      if (!(err instanceof ApiClientError)) return setError(UNEXPECTED_ERROR_MESSAGE);
      if (CHALLENGE_OVER.has(err.code)) return onBack(err.message);
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
    if (resending || left > 0) return;
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiFetch<SignInAgainResponse>("/api/auth/sign-in", {
        method: "POST",
        body: { email: credentials.email, password: credentials.password, ...(credentials.next ? { next: credentials.next } : {}) },
      });
      if (!res.requires2fa) return leaveAuthPage(res.redirectTo);
      const sentAt = Date.now();
      setChallenge({ challengeId: res.challengeId, emailHint: res.emailHint, sentAt });
      setResendUntil(sentAt + RESEND_COOLDOWN_SEC * 1000);
      setCode("");
      setTried(false);
      setServerError(null);
      setNotice(AUTH_COPY.twoStep.resent);
    } catch (err) {
      if (!(err instanceof ApiClientError)) return setError(UNEXPECTED_ERROR_MESSAGE);
      if (err.code === "invalid_credentials") return onBack(err.message);
      const wait = retryAfterFrom(err.details);
      if (wait) setResendUntil(Date.now() + wait * 1000);
      setError(err.message);
    } finally {
      setResending(false);
    }
  }

  return (
    <>
      <AuthHeading
        title={AUTH_COPY.twoStep.title}
        subtitle={<span id={IDS.subtitle}>{AUTH_COPY.twoStep.subtitle(challenge.emailHint)}</span>}
      />
      {notice ? <AuthNotice>{notice}</AuthNotice> : null}
      {summary.length > 0 ? (
        <AuthErrorSummary id={IDS.summary} errors={summary} />
      ) : error ? (
        <AuthErrorBanner>{error}</AuthErrorBanner>
      ) : null}
      <form noValidate onSubmit={onSubmit} className="mt-[22px] grid gap-4">
        <Field id={IDS.code} label={AUTH_COPY.twoStep.code} error={fieldError}>
          <CodeInput
            name="code"
            aria-describedby={IDS.subtitle}
            value={code}
            onValueChange={(value) => {
              setCode(value);
              setServerError(null);
            }}
          />
        </Field>
        <div className="flex items-start gap-2.5">
          <Checkbox
            id={IDS.trust}
            checked={trust}
            onCheckedChange={(value) => setTrust(value === true)}
            aria-describedby={IDS.trustHint}
            className="mt-[3px]"
          />
          <div className="grid gap-0.5">
            <Label htmlFor={IDS.trust} className="cursor-pointer">
              {AUTH_COPY.twoStep.trust}
            </Label>
            <p id={IDS.trustHint} className="m-0 text-[13px] font-semibold text-ink-2">
              {AUTH_COPY.twoStep.trustHint}
            </p>
          </div>
        </div>
        <AuthSubmit busy={busy}>{AUTH_COPY.twoStep.cta}</AuthSubmit>
      </form>
      <AuthFooter
        items={[
          {
            pre: AUTH_COPY.twoStep.resendPre,
            label: left > 0 ? AUTH_COPY.resendIn(left) : AUTH_COPY.twoStep.resend,
            onClick: () => void resend(),
            disabled: left > 0 || resending,
          },
          { label: AUTH_COPY.twoStep.back, onClick: () => onBack(null) },
        ]}
      />
    </>
  );
}
