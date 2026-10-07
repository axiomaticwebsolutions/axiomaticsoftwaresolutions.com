"use client";

import Link from "next/link";
import * as React from "react";
import { takeRegisterPrefill } from "@/components/store/order/session-keys";
import { Field, type FormError } from "@/components/ui/field";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import {
  emailPrefill,
  hasErrors,
  REGISTER_FIELDS,
  safeRedirectTarget,
  serverFieldErrors,
  validateRegister,
  withCreatedFlag,
  withNext,
  type FieldErrorMap,
  type RegisterField,
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
} from "./auth-ui";
import { AUTH_COPY } from "./copy";
import { NewPasswordField } from "./new-password-field";

export type RegisterFormProps = {
  /** Where to continue after verification (safe path; a trial slug is already folded in as ?trial=). */
  continueTo: string | null;
  /** The trial CTA (?trial=<slug>) changes the title, notice and button. */
  trial: boolean;
  initialEmail: string;
};

const FIELD_IDS: Record<RegisterField, string> = {
  name: "register-name",
  businessName: "register-business",
  email: "register-email",
  password: "register-password",
};
const SUMMARY_ID = "register-errors";

type Banner = { kind: "text"; message: string } | { kind: "email_taken" };

/** /register (Account.dc.html mode "register"). Success signs the user in and continues to /verify. */
export function RegisterForm({ continueTo, trial, initialEmail }: RegisterFormProps) {
  const [values, setValues] = React.useState<Record<RegisterField, string>>({
    name: "",
    businessName: "",
    email: initialEmail,
    password: "",
  });
  const [showPassword, setShowPassword] = React.useState(false);
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<FieldErrorMap<RegisterField>>({});
  const [banner, setBanner] = React.useState<Banner | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [focusRequest, setFocusRequest] = React.useState<{ id: string; at: number } | null>(null);

  React.useEffect(() => {
    if (focusRequest) document.getElementById(focusRequest.id)?.focus();
  }, [focusRequest]);

  // The order page's "Create account" hands the order email over in sessionStorage (never in the URL). Read once.
  React.useEffect(() => {
    const email = emailPrefill(takeRegisterPrefill());
    if (!email || initialEmail) return;
    setValues((prev) => (prev.email ? prev : { ...prev, email }));
  }, [initialEmail]);

  const clientErrors = tried ? validateRegister(values) : {};
  const errors: FieldErrorMap<RegisterField> = {};
  for (const key of REGISTER_FIELDS) {
    const message = clientErrors[key] ?? serverErrors[key];
    if (message) errors[key] = message;
  }
  const summary: FormError[] = REGISTER_FIELDS.flatMap((key) => {
    const message = errors[key];
    return message ? [{ fieldId: FIELD_IDS[key], message }] : [];
  });

  function set(key: RegisterField, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setServerErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setShowPassword(false);
    if (hasErrors(validateRegister(values))) {
      setTried(true);
      setServerErrors({});
      setBanner(null);
      setFocusRequest({ id: SUMMARY_ID, at: Date.now() });
      return;
    }
    setBusy(true);
    setBanner(null);
    const businessName = values.businessName.trim();
    try {
      const res = await apiFetch<{ redirectTo: string }>("/api/auth/register", {
        method: "POST",
        body: {
          name: values.name,
          email: values.email,
          password: values.password,
          ...(businessName ? { businessName } : {}),
          ...(continueTo ? { next: continueTo } : {}),
        },
      });
      leaveAuthPage(withCreatedFlag(safeRedirectTarget(res.redirectTo, "/verify")), "/verify");
    } catch (err) {
      setBusy(false);
      if (!(err instanceof ApiClientError)) return setBanner({ kind: "text", message: UNEXPECTED_ERROR_MESSAGE });
      if (err.code === "email_taken") return setBanner({ kind: "email_taken" });
      if (err.code === "validation_failed") {
        const fields = serverFieldErrors(err.fieldErrors, REGISTER_FIELDS);
        if (hasErrors(fields)) {
          setServerErrors(fields);
          setTried(true);
          return setFocusRequest({ id: SUMMARY_ID, at: Date.now() });
        }
      }
      setBanner({ kind: "text", message: err.message });
    }
  }

  const signInHref = withNext("/sign-in", continueTo);

  return (
    <>
      <AuthHeading
        title={trial ? AUTH_COPY.register.trialTitle : AUTH_COPY.register.title}
        subtitle={AUTH_COPY.register.subtitle}
      />
      {trial ? <AuthNotice>{AUTH_COPY.register.trialNotice}</AuthNotice> : null}
      {summary.length > 0 ? (
        <AuthErrorSummary id={SUMMARY_ID} errors={summary} />
      ) : banner?.kind === "email_taken" ? (
        <AuthErrorBanner>
          <span>
            {AUTH_COPY.register.emailTakenLead}{" "}
            <Link href={signInHref} className={cn(AUTH_LINK_CLASS, "text-danger hover:text-ink")}>
              {AUTH_COPY.register.emailTakenLink}
            </Link>
          </span>
        </AuthErrorBanner>
      ) : banner ? (
        <AuthErrorBanner>{banner.message}</AuthErrorBanner>
      ) : null}
      <form noValidate onSubmit={onSubmit} className="mt-[22px] grid gap-4">
        <Field id={FIELD_IDS.name} label={AUTH_COPY.register.name} error={errors.name}>
          <AuthInput
            name="name"
            autoComplete="name"
            maxLength={120}
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
          />
        </Field>
        <Field id={FIELD_IDS.businessName} label={AUTH_COPY.register.business} error={errors.businessName}>
          <AuthInput
            name="organization"
            autoComplete="organization"
            maxLength={160}
            value={values.businessName}
            onChange={(event) => set("businessName", event.target.value)}
          />
        </Field>
        <Field id={FIELD_IDS.email} label={AUTH_COPY.register.email} error={errors.email}>
          <AuthInput
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            spellCheck={false}
            autoCapitalize="none"
            maxLength={254}
            value={values.email}
            onChange={(event) => set("email", event.target.value)}
          />
        </Field>
        <NewPasswordField
          id={FIELD_IDS.password}
          label={AUTH_COPY.register.password}
          value={values.password}
          onChange={(value) => set("password", value)}
          error={errors.password}
          visible={showPassword}
          onVisibleChange={setShowPassword}
        />
        <AuthSubmit busy={busy}>{trial ? AUTH_COPY.register.trialCta : AUTH_COPY.register.cta}</AuthSubmit>
      </form>
      <AuthFooter items={[{ pre: AUTH_COPY.register.footerPre, label: AUTH_COPY.register.footerLink, href: signInHref }]} />
    </>
  );
}
