"use client";

import Link from "next/link";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormErrorSummary } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { OptionalTag } from "@/components/ui/label";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { PHONE_INPUT_MAX } from "@/lib/validation/contact";
import { createLeadRequestSchema, leadFieldErrors, LEAD_MAX } from "@/lib/validation/lead";
import { COMING_SOON_COPY } from "./copy";
import {
  EMPTY_WAITLIST_VALUES,
  WAITLIST_FIELD_ORDER,
  waitlistFieldId,
  waitlistRequestBody,
  type WaitlistFieldKey,
  type WaitlistValues,
} from "./waitlist-model";

const SUMMARY_ID = "waitlist-error-summary";
const CONTROL = "rounded-12 font-semibold";

export type WaitlistFormProps = {
  productId: string;
  /** Full name for the success message ("... when Payroll & Attendance Software launches"). */
  productName: string;
  /** Display name for the lede and the purpose notice. */
  shortName: string;
};

function OptionalLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="grid gap-0.5">
      <span>{children}</span>
      <OptionalTag>{COMING_SOON_COPY.optional}</OptionalTag>
    </span>
  );
}

/**
 * "Notify me when it launches" on a COMING_SOON product page: name and email (required), phone and business name
 * (optional), the purpose notice and the hidden honeypot. Same schema as POST /api/contact (kind "waitlist"), which
 * answers the same way for a new and a repeated sign-up; the page confirms it ("Thanks — we'll email you ...").
 */
export function WaitlistForm({ productId, productName, shortName }: WaitlistFormProps) {
  const [values, setValues] = React.useState<WaitlistValues>(EMPTY_WAITLIST_VALUES);
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<Partial<Record<WaitlistFieldKey, string>>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [focusTick, setFocusTick] = React.useState(0);
  const sentRef = React.useRef<HTMLHeadingElement>(null);
  const titleId = React.useId();

  const schema = React.useMemo(() => createLeadRequestSchema({ demoProductIds: [], waitlistProductIds: [productId] }), [productId]);

  React.useEffect(() => {
    if (sent) sentRef.current?.focus();
  }, [sent]);

  // After a failed submit (each time), move focus to the error summary once it has rendered.
  React.useEffect(() => {
    if (focusTick > 0) document.getElementById(SUMMARY_ID)?.focus();
  }, [focusTick]);

  const clientErrors = React.useMemo(() => {
    if (!tried) return {} as Record<string, string>;
    const parsed = schema.safeParse(waitlistRequestBody(productId, values));
    return parsed.success ? {} : leadFieldErrors(parsed.error);
  }, [tried, schema, productId, values]);

  const errors: Partial<Record<WaitlistFieldKey, string>> = {};
  for (const key of WAITLIST_FIELD_ORDER) {
    const message = clientErrors[key] ?? serverErrors[key];
    if (message) errors[key] = message;
  }
  const summary = WAITLIST_FIELD_ORDER.flatMap((key) => {
    const message = errors[key];
    return message ? [{ fieldId: waitlistFieldId(key), message }] : [];
  });

  const change = (key: keyof WaitlistValues) => (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    setValues((prev) => ({ ...prev, [key]: value }));
    setServerErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key as WaitlistFieldKey];
      return next;
    });
  };

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const body = waitlistRequestBody(productId, values);
    if (!schema.safeParse(body).success) {
      setTried(true);
      setServerErrors({});
      setFormError(null);
      setFocusTick((n) => n + 1);
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await apiFetch<{ ok: true }>("/api/contact", { method: "POST", body });
      setSent(true);
    } catch (error) {
      if (error instanceof ApiClientError) {
        const fields: Partial<Record<WaitlistFieldKey, string>> = {};
        for (const key of WAITLIST_FIELD_ORDER) {
          const first = error.fieldErrors[key]?.[0];
          if (first) fields[key] = first;
        }
        if (error.status === 422 && Object.keys(fields).length > 0) {
          setServerErrors(fields);
          setTried(true);
          setFocusTick((n) => n + 1);
        } else {
          setFormError(error.fieldErrors.product?.[0] ?? error.message);
        }
      } else if (!(error instanceof DOMException && error.name === "AbortError")) {
        setFormError(UNEXPECTED_ERROR_MESSAGE);
      }
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div role="status" className="rounded-22 border border-sage-line bg-sage-bg p-6">
        <span aria-hidden="true" className="grid size-12 place-items-center rounded-[15px] bg-surface text-sage-fg">
          <Icon name="check_circle" size={26} />
        </span>
        <h2 ref={sentRef} tabIndex={-1} className="mb-0 mt-3.5 text-[21px] font-extrabold leading-[normal]">
          {COMING_SOON_COPY.sentTitle}
        </h2>
        <p className="mb-0 mt-2 text-[15.5px] leading-[1.6] text-ink-soft">{COMING_SOON_COPY.sentBody(productName)}</p>
      </div>
    );
  }

  return (
    <form
      noValidate
      onSubmit={onSubmit}
      aria-labelledby={titleId}
      className="grid gap-4 rounded-22 border border-line bg-surface p-6 shadow-tile"
    >
      <div>
        <h2 id={titleId} className="m-0 text-[21px] font-extrabold leading-[1.3] tracking-[-0.01em]">
          {COMING_SOON_COPY.formTitle}
        </h2>
        <p className="m-0 mt-1.5 text-[14.5px] leading-[1.55] text-ink-2">{COMING_SOON_COPY.formLede(shortName)}</p>
      </div>
      {formError ? <Alert tone="danger">{formError}</Alert> : null}
      <FormErrorSummary id={SUMMARY_ID} errors={summary} focusOnMount={false} className="rounded-12 px-3.5 py-3 text-[14.5px]" />
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-3.5">
        <Field id={waitlistFieldId("name")} label={COMING_SOON_COPY.name} error={errors.name} className="leading-[normal]">
          <Input name="name" autoComplete="name" maxLength={LEAD_MAX.name} value={values.name} onChange={change("name")} className={CONTROL} />
        </Field>
        <Field id={waitlistFieldId("email")} label={COMING_SOON_COPY.email} error={errors.email} className="leading-[normal]">
          <Input
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            spellCheck={false}
            value={values.email}
            onChange={change("email")}
            className={CONTROL}
          />
        </Field>
        <Field id={waitlistFieldId("phone")} label={<OptionalLabel>{COMING_SOON_COPY.phone}</OptionalLabel>} error={errors.phone} className="leading-[normal]">
          <Input
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            maxLength={PHONE_INPUT_MAX}
            value={values.phone}
            onChange={change("phone")}
            className={CONTROL}
          />
        </Field>
        <Field
          id={waitlistFieldId("businessName")}
          label={<OptionalLabel>{COMING_SOON_COPY.businessName}</OptionalLabel>}
          error={errors.businessName}
          className="leading-[normal]"
        >
          <Input
            name="businessName"
            autoComplete="organization"
            maxLength={LEAD_MAX.businessName}
            value={values.businessName}
            onChange={change("businessName")}
            className={CONTROL}
          />
        </Field>
      </div>
      <p className="m-0 text-[13.5px] font-semibold leading-[1.5] text-ink-2">
        {COMING_SOON_COPY.noticeBeforeLink(shortName)}
        <Link href={COMING_SOON_COPY.privacyHref} className="text-primary-link underline underline-offset-2 hover:text-primary-link-hover">
          {COMING_SOON_COPY.noticeLink}
        </Link>
        {COMING_SOON_COPY.noticeAfterLink}
      </p>
      {/* Honeypot: hidden from people and assistive technology; bots that fill every field get the usual answer. */}
      <div aria-hidden="true" className="sr-only">
        <label htmlFor="waitlist-website">{COMING_SOON_COPY.honeypotLabel}</label>
        <input
          id="waitlist-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          data-1p-ignore=""
          data-lpignore="true"
          value={values.website}
          onChange={change("website")}
        />
      </div>
      <Button
        type="submit"
        size="lg"
        loading={busy}
        loadingText={COMING_SOON_COPY.sending}
        className="justify-self-start gap-2.5 py-3.5 text-[15.5px] font-extrabold leading-[normal] shadow-none aria-disabled:opacity-100"
      >
        <Icon name="notifications" size={20} />
        {COMING_SOON_COPY.submit}
      </Button>
    </form>
  );
}
