"use client";

import Link from "next/link";
import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Alert } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { signInPath } from "@/lib/auth/redirect";
import { INDIAN_STATES } from "@/lib/validation/states";
import { cn } from "@/lib/utils";
import {
  CHECKOUT_COPY,
  checkoutFieldId,
  gstinHelper,
  initialsOf,
  passwordHelper,
  sanitizeGstinInput,
  type CheckoutErrors,
  type CheckoutValues,
  type HelperTone,
} from "./checkout-form";
import type { CheckoutViewer } from "./checkout-viewer";

export type SetCheckoutValue = <K extends keyof CheckoutValues>(key: K, value: CheckoutValues[K]) => void;

const SECTION_CLASS = "rounded-22 border border-line bg-surface p-6";
const H2_CLASS = "m-0 text-[18px] font-extrabold outline-none";
const INPUT_CLASS = "rounded-12 font-semibold";
const FIELDS_GRID = "mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,220px),1fr))] gap-4";

const HELPER_TONE: Readonly<Record<HelperTone, string>> = {
  neutral: "text-ink-2",
  valid: "text-sage-fg",
  error: "text-danger",
};

export type AccountSectionProps = {
  viewer: CheckoutViewer | null;
  onSignOut: () => void;
  signingOut: boolean;
  headingRef?: React.Ref<HTMLHeadingElement>;
};

/** "Account": the signed-in identity with "Not you?", or the guest notice with "Sign in". */
export function AccountSection({ viewer, onSignOut, signingOut, headingRef }: AccountSectionProps) {
  return (
    <section aria-labelledby="checkout-account-h" className={SECTION_CLASS}>
      <h2 id="checkout-account-h" ref={headingRef} tabIndex={-1} className={H2_CLASS}>
        {CHECKOUT_COPY.account}
      </h2>
      {viewer ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span
              aria-hidden="true"
              className="grid size-10 place-items-center rounded-pill bg-lavender-bg font-extrabold text-lavender-fg"
            >
              {initialsOf(viewer.name)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-bold">{CHECKOUT_COPY.signedInAs(viewer.name)}</div>
              <div className="text-[14px] text-ink-2">{CHECKOUT_COPY.signedInBody}</div>
            </div>
            <button
              type="button"
              onClick={onSignOut}
              disabled={signingOut}
              className="cursor-pointer rounded-6 border-0 bg-transparent p-0 font-bold text-primary-link hover:text-primary-link-hover disabled:cursor-progress"
            >
              {CHECKOUT_COPY.notYou}
            </button>
          </div>
          {viewer.blockedMessage ? (
            <Alert tone="danger" role="note" className="mt-3">
              <span className="font-semibold">{viewer.blockedMessage}</span>
            </Alert>
          ) : null}
        </>
      ) : (
        <div className="mt-3 flex flex-wrap items-start gap-3 rounded-14 bg-lavender-soft px-4 py-3.5">
          <Icon name="person" size={22} className="text-lavender-fg" />
          <div className="min-w-0 flex-[1_1_200px] text-[14.5px] leading-[1.55]">
            <strong>{CHECKOUT_COPY.guestLead}</strong> {CHECKOUT_COPY.guestBody}
          </div>
          <Link
            href={signInPath("/checkout")}
            className="rounded-6 text-[14.5px] font-bold text-primary-link underline hover:text-primary-link-hover"
          >
            {CHECKOUT_COPY.signIn}
          </Link>
        </div>
      )}
    </section>
  );
}

type TextFieldProps = {
  field: "name" | "email" | "phone" | "business" | "address" | "city" | "pin";
  label: string;
  values: CheckoutValues;
  errors: CheckoutErrors;
  onChange: SetCheckoutValue;
  type?: "text" | "email" | "tel";
  autoComplete: string;
  placeholder?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"];
  className?: string;
  maxLength?: number;
};

function TextField({ field, label, values, errors, onChange, type = "text", autoComplete, placeholder, inputMode, className, maxLength }: TextFieldProps) {
  return (
    <Field id={checkoutFieldId(field)} label={label} error={errors[field]} className={cn("leading-[normal]", className)}>
      <Input
        name={field}
        type={type}
        value={values[field]}
        onChange={(event) => onChange(field, event.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        className={INPUT_CLASS}
      />
    </Field>
  );
}

/** A line under a control that changes colour with its state (GSTIN status, password strength). */
function HelperText({ id, line, live }: { id: string; line: { message: string; tone: HelperTone }; live: boolean }) {
  if (line.tone === "error") {
    return (
      <FieldError id={id} role={live ? "alert" : undefined}>
        {line.message}
      </FieldError>
    );
  }
  return (
    <p id={id} role={live ? "status" : undefined} className={cn("m-0 text-[13px] font-semibold", HELPER_TONE[line.tone])}>
      {line.message}
    </p>
  );
}

export type FormSectionProps = { values: CheckoutValues; errors: CheckoutErrors; onChange: SetCheckoutValue };

/** "Contact details": name, email, mobile; for guests the create-account checkbox and password. */
export function ContactSection({ values, errors, onChange, guest }: FormSectionProps & { guest: boolean }) {
  const passwordId = checkoutFieldId("password");
  const help = passwordHelper(values.password, errors.password);
  return (
    <section aria-labelledby="checkout-contact-h" className={SECTION_CLASS}>
      <h2 id="checkout-contact-h" className={H2_CLASS}>
        {CHECKOUT_COPY.contact}
      </h2>
      <div className={FIELDS_GRID}>
        <TextField field="name" label={CHECKOUT_COPY.name} autoComplete="name" values={values} errors={errors} onChange={onChange} />
        <TextField
          field="email"
          type="email"
          label={CHECKOUT_COPY.email}
          autoComplete="email"
          placeholder={CHECKOUT_COPY.emailPlaceholder}
          values={values}
          errors={errors}
          onChange={onChange}
        />
        <TextField
          field="phone"
          type="tel"
          label={CHECKOUT_COPY.phone}
          autoComplete="tel"
          placeholder={CHECKOUT_COPY.phonePlaceholder}
          values={values}
          errors={errors}
          onChange={onChange}
        />
      </div>
      {guest ? (
        <>
          <div className="mt-4 flex items-center gap-2.5">
            <Checkbox
              id="checkout-create-account"
              checked={values.createAccount}
              onCheckedChange={(checked) => onChange("createAccount", checked === true)}
            />
            <label htmlFor="checkout-create-account" className="cursor-pointer text-[14.5px] font-semibold">
              {CHECKOUT_COPY.createAccount}
            </label>
          </div>
          {values.createAccount ? (
            <div className="mt-3 grid max-w-[360px] gap-1.5">
              <Label htmlFor={passwordId}>{CHECKOUT_COPY.password}</Label>
              <Input
                id={passwordId}
                name="new-password"
                type="password"
                value={values.password}
                onChange={(event) => onChange("password", event.target.value)}
                autoComplete="new-password"
                aria-invalid={errors.password ? true : undefined}
                aria-describedby="checkout-password-help"
                className={cn(INPUT_CLASS, "font-normal")}
              />
              <HelperText id="checkout-password-help" line={help} live={false} />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** "Billing details": business, address, city, PIN, state, and the GSTIN box. */
export function BillingSection({ values, errors, onChange }: FormSectionProps) {
  const stateId = checkoutFieldId("state");
  const gstinId = checkoutFieldId("gstin");
  const gstin = gstinHelper(values.gstin, values.state, errors.gstin);
  const gstinValid = gstin.tone === "valid";
  return (
    <section aria-labelledby="checkout-billing-h" className={SECTION_CLASS}>
      <h2 id="checkout-billing-h" className={H2_CLASS}>
        {CHECKOUT_COPY.billing}
      </h2>
      <p className="mb-0 mt-1.5 text-[14px] text-ink-2">{CHECKOUT_COPY.billingBody}</p>
      <div className={FIELDS_GRID}>
        <TextField
          field="business"
          label={CHECKOUT_COPY.business}
          autoComplete="organization"
          className="col-span-full"
          values={values}
          errors={errors}
          onChange={onChange}
        />
        <TextField
          field="address"
          label={CHECKOUT_COPY.address}
          autoComplete="street-address"
          className="col-span-full"
          values={values}
          errors={errors}
          onChange={onChange}
        />
        <TextField field="city" label={CHECKOUT_COPY.city} autoComplete="address-level2" values={values} errors={errors} onChange={onChange} />
        <TextField
          field="pin"
          label={CHECKOUT_COPY.pin}
          autoComplete="postal-code"
          inputMode="numeric"
          placeholder={CHECKOUT_COPY.pinPlaceholder}
          values={values}
          errors={errors}
          onChange={onChange}
        />
        <Field id={stateId} label={CHECKOUT_COPY.state} error={errors.state} className="leading-[normal]">
          <NativeSelect
            name="state"
            autoComplete="address-level1"
            placeholder={CHECKOUT_COPY.statePlaceholder}
            value={values.state}
            onChange={(event) => onChange("state", event.target.value)}
            className={cn(INPUT_CLASS, "pl-3")}
          >
            {INDIAN_STATES.map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="mt-[18px] rounded-14 border border-line-subtle bg-bg p-4">
        <div className="flex items-center gap-2.5">
          <Checkbox id="checkout-has-gstin" checked={values.hasGstin} onCheckedChange={(checked) => onChange("hasGstin", checked === true)} />
          <label htmlFor="checkout-has-gstin" className="cursor-pointer text-[14.5px] font-bold">
            {CHECKOUT_COPY.gstinToggle} <span className="font-semibold text-ink-2">{CHECKOUT_COPY.optional}</span>
          </label>
        </div>
        {values.hasGstin ? (
          <div className="mt-3 grid max-w-[360px] gap-1.5">
            <Label htmlFor={gstinId}>{CHECKOUT_COPY.gstin}</Label>
            <Input
              id={gstinId}
              name="gstin"
              mono
              value={values.gstin}
              onChange={(event) => onChange("gstin", sanitizeGstinInput(event.target.value))}
              maxLength={15}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="characters"
              placeholder={CHECKOUT_COPY.gstinPlaceholder}
              aria-invalid={errors.gstin ? true : undefined}
              aria-describedby="checkout-gstin-help"
              className={cn(INPUT_CLASS, "font-medium uppercase tracking-[0.04em]", gstinValid && "border-success")}
            />
            <HelperText id="checkout-gstin-help" line={gstin} live />
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** "I agree to the License agreement, Terms and Refund policy." (documents open in a new tab, keeping the form). */
export function TermsField({ checked, error, onChange }: { checked: boolean; error?: string; onChange: (checked: boolean) => void }) {
  const id = checkoutFieldId("agree");
  const doc = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener" className="rounded-6 text-primary-link underline hover:text-primary-link-hover">
      {label}
      <span className="sr-only"> {CHECKOUT_COPY.newTab}</span>
    </a>
  );
  return (
    <div className="flex items-start gap-2.5 px-1">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        className="mt-[3px]"
      />
      <div className="grid gap-1">
        <label htmlFor={id} className="cursor-pointer text-[14.5px] font-semibold leading-[1.55]">
          {CHECKOUT_COPY.agreePrefix}
          {doc("/legal/eula", CHECKOUT_COPY.eula)}, {doc("/legal/terms", CHECKOUT_COPY.terms)} and{" "}
          {doc("/legal/refund", CHECKOUT_COPY.refund)}.
        </label>
        {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
      </div>
    </div>
  );
}
