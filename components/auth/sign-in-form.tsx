"use client";

import Link from "next/link";
import * as React from "react";
import { takeSignInPrefill } from "@/components/store/order/session-keys";
import { Field, type FormError } from "@/components/ui/field";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import {
  emailPrefill,
  hasErrors,
  serverFieldErrors,
  SIGN_IN_FIELDS,
  validateSignIn,
  withNext,
  type FieldErrorMap,
  type SignInField,
} from "./auth-model";
import {
  AUTH_LINK_CLASS,
  AuthErrorBanner,
  AuthErrorSummary,
  AuthFooter,
  AuthHeading,
  AuthInput,
  AuthNotice,
  AuthSubmit,
  leaveAuthPage,
  PasswordInput,
} from "./auth-ui";
import { AUTH_COPY } from "./copy";
import { TwoStepStep, type LoginChallenge } from "./two-step-step";

export type SignInResponse =
  | { requires2fa: false; redirectTo: string }
  | { requires2fa: true; challengeId: string; emailHint: string };

export type SignInFormProps = {
  /** Safe relative path to continue to (already validated on the server). */
  next: string | null;
  /** From ?email= (validated). */
  initialEmail: string;
  /** "Password updated. Sign in with your new password." after a reset. */
  initialNotice: string | null;
};

const IDS = { email: "sign-in-email", password: "sign-in-password", summary: "sign-in-errors" } as const;
const FIELD_IDS: Record<SignInField, string> = { email: IDS.email, password: IDS.password };

/**
 * /sign-in (Account.dc.html mode "signin"), then the two-step code step when the API asks for it. The password stays
 * in memory while the code step is open, so "Resend code" can ask for a fresh code (the API has no separate resend).
 */
export function SignInForm({ next, initialEmail, initialNotice }: SignInFormProps) {
  const [challenge, setChallenge] = React.useState<LoginChallenge | null>(null);
  const [email, setEmail] = React.useState(initialEmail);
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<FieldErrorMap<SignInField>>({});
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(initialNotice);
  const [busy, setBusy] = React.useState(false);
  const [focusRequest, setFocusRequest] = React.useState<{ id: string; at: number } | null>(null);
  const headingRef = React.useRef<HTMLHeadingElement>(null);

  // After a password reset (or the checkout's "Sign in instead.") the account email arrives in sessionStorage. Read once.
  React.useEffect(() => {
    const handed = emailPrefill(takeSignInPrefill());
    if (!handed || initialEmail) return;
    setEmail((prev) => prev || handed);
  }, [initialEmail]);

  React.useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.id === "heading") headingRef.current?.focus();
    else document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);

  const clientErrors = tried ? validateSignIn({ email, password }) : {};
  const errors: FieldErrorMap<SignInField> = {};
  for (const key of SIGN_IN_FIELDS) {
    const message = clientErrors[key] ?? serverErrors[key];
    if (message) errors[key] = message;
  }
  const summary: FormError[] = SIGN_IN_FIELDS.flatMap((key) => {
    const message = errors[key];
    return message ? [{ fieldId: FIELD_IDS[key], message }] : [];
  });

  function clearServerError(key: SignInField) {
    setServerErrors((prev) => (key in prev ? { ...prev, [key]: undefined } : prev));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setShowPassword(false);
    if (hasErrors(validateSignIn({ email, password }))) {
      setTried(true);
      setServerErrors({});
      setError(null);
      setFocusRequest({ id: IDS.summary, at: event.timeStamp });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<SignInResponse>("/api/auth/sign-in", {
        method: "POST",
        body: { email, password, ...(next ? { next } : {}) },
      });
      if (res.requires2fa) {
        setNotice(null);
        setTried(false);
        setChallenge({ challengeId: res.challengeId, emailHint: res.emailHint, sentAt: Date.now() });
        setBusy(false);
        return;
      }
      leaveAuthPage(res.redirectTo);
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiClientError && err.status === 422 && err.code === "validation_failed") {
        const fields = serverFieldErrors(err.fieldErrors, SIGN_IN_FIELDS);
        if (hasErrors(fields)) {
          setServerErrors(fields);
          setTried(true);
          setFocusRequest({ id: IDS.summary, at: Date.now() });
          return;
        }
      }
      setError(err instanceof ApiClientError ? err.message : UNEXPECTED_ERROR_MESSAGE);
    }
  }

  if (challenge) {
    return (
      <TwoStepStep
        initialChallenge={challenge}
        credentials={{ email, password, next }}
        onBack={(message) => {
          setChallenge(null);
          setError(message);
          if (!message) setPassword("");
          setFocusRequest({ id: "heading", at: Date.now() });
        }}
      />
    );
  }

  return (
    <>
      <AuthHeading title={AUTH_COPY.signIn.title} subtitle={AUTH_COPY.signIn.subtitle} headingRef={headingRef} />
      {notice ? <AuthNotice>{notice}</AuthNotice> : null}
      {summary.length > 0 ? (
        <AuthErrorSummary id={IDS.summary} errors={summary} />
      ) : error ? (
        <AuthErrorBanner>{error}</AuthErrorBanner>
      ) : null}
      <form noValidate onSubmit={onSubmit} className="mt-[22px] grid gap-4">
        <Field id={IDS.email} label={AUTH_COPY.signIn.email} error={errors.email}>
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
              clearServerError("email");
            }}
          />
        </Field>
        <Field
          id={IDS.password}
          label={AUTH_COPY.signIn.password}
          error={errors.password}
          labelAction={
            <Link href="/forgot" className={cn(AUTH_LINK_CLASS, "text-[14px] font-bold")}>
              {AUTH_COPY.signIn.forgot}
            </Link>
          }
        >
          {(control) => (
            <PasswordInput
              {...control}
              name="password"
              autoComplete="current-password"
              maxLength={1024}
              visible={showPassword}
              onVisibleChange={setShowPassword}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                clearServerError("password");
              }}
            />
          )}
        </Field>
        <AuthSubmit busy={busy}>{AUTH_COPY.signIn.cta}</AuthSubmit>
      </form>
      <AuthFooter
        items={[{ pre: AUTH_COPY.signIn.footerPre, label: AUTH_COPY.signIn.footerLink, href: withNext("/register", next) }]}
      />
    </>
  );
}
