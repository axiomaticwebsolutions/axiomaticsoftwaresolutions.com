"use client";

import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FormErrorSummary, type FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { CUSTOMER_RECORD_COPY as COPY, type CustomerEditDraft } from "@/lib/admin/customers/model";
import { INDIAN_STATES } from "@/lib/validation/states";

/** Draft of the "New customer" form and the drawer's edit card (strings; empty = none). */
export type CustomerDraft = CustomerEditDraft;

export type CustomerFieldKey = keyof CustomerDraft;

/** Field order (error summary, focus). */
export const CUSTOMER_FIELD_ORDER: readonly CustomerFieldKey[] = [
  "name",
  "email",
  "phone",
  "emailVerified",
  "legalName",
  "gstin",
  "address",
  "city",
  "state",
  "pin",
  "reason",
];

export const fieldId = (prefix: string, key: CustomerFieldKey) => `${prefix}-${key}`;

/** "Please fix …" summary entries in field order (each links to and focuses its field). */
export function summaryErrors(prefix: string, fields: Record<string, string>): FormError[] {
  return CUSTOMER_FIELD_ORDER.flatMap((key) => (fields[key] ? [{ fieldId: fieldId(prefix, key), message: fields[key] }] : []));
}

/** Form-level refusal (rate limit, permission, conflict without a field). Announced, not focused. */
export function FormAlert({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="m-0 rounded-8 bg-pink-bg px-2.5 py-2 text-[13px] font-bold text-danger">
      {children}
    </p>
  );
}

/** Error summary sized for the drawer (focuses itself after a failed submit). */
export function CustomerErrorSummary({ prefix, fields }: { prefix: string; fields: Record<string, string> }) {
  const errors = summaryErrors(prefix, fields);
  if (errors.length === 0) return null;
  return <FormErrorSummary errors={errors} className="rounded-10 px-3 py-2.5 text-[13px] [&_li]:text-[13px]" />;
}

const twoColumns = "grid gap-2.5 min-[26.25rem]:grid-cols-2";

function Legend({ children }: { children: React.ReactNode }) {
  return <legend className="mb-1.5 p-0 text-[12.5px] font-extrabold text-ink">{children}</legend>;
}

type FieldsProps = {
  prefix: string;
  draft: CustomerDraft;
  onChange: (draft: CustomerDraft) => void;
  errors: Record<string, string>;
  /** Show the person fieldset (name, email, mobile). */
  person: boolean;
  /** Note above the person fields (edit: they change in every account the person is in). */
  personNote?: React.ReactNode;
  /** Extra content after the email (the "verified" checkbox and the email-change warning). */
  afterEmail?: React.ReactNode;
  legalNameLabel: string;
  legalNameHint?: string;
};

/** Person and business fieldsets shared by "New customer" and the edit card. Labels and errors are tied to fields. */
export function CustomerFields({ prefix, draft, onChange, errors, person, personNote, afterEmail, legalNameLabel, legalNameHint }: FieldsProps) {
  const set = <K extends keyof CustomerDraft>(key: K, value: CustomerDraft[K]) => onChange({ ...draft, [key]: value });
  return (
    <>
      {person ? (
        <fieldset className="m-0 grid min-w-0 gap-2.5 border-0 p-0">
          <Legend>{COPY.person}</Legend>
          {personNote ? <p className="m-0 text-[12px] text-ink-2">{personNote}</p> : null}
          <Field size="sm" label={COPY.name} required error={errors.name} id={fieldId(prefix, "name")}>
            <Input size="sm" autoComplete="off" maxLength={120} value={draft.name} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <div className={twoColumns}>
            <Field size="sm" label={COPY.email} required hint={COPY.emailHint} error={errors.email} id={fieldId(prefix, "email")}>
              <Input
                size="sm"
                type="email"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                maxLength={254}
                value={draft.email}
                onChange={(e) => set("email", e.target.value)}
              />
            </Field>
            <Field size="sm" label={COPY.mobile} optional hint={COPY.mobileHint} error={errors.phone} id={fieldId(prefix, "phone")}>
              <Input size="sm" type="tel" inputMode="tel" autoComplete="off" maxLength={20} value={draft.phone} onChange={(e) => set("phone", e.target.value)} />
            </Field>
          </div>
          {afterEmail}
        </fieldset>
      ) : null}
      <fieldset className="m-0 grid min-w-0 gap-2.5 border-0 p-0">
        <Legend>{COPY.business}</Legend>
        <Field size="sm" label={legalNameLabel} optional={legalNameHint !== undefined} hint={legalNameHint} error={errors.legalName} id={fieldId(prefix, "legalName")}>
          <Input size="sm" autoComplete="off" maxLength={160} value={draft.legalName} onChange={(e) => set("legalName", e.target.value)} />
        </Field>
        <div className={twoColumns}>
          <Field size="sm" label={COPY.gstin} optional hint={COPY.gstinHint} error={errors.gstin} id={fieldId(prefix, "gstin")}>
            <Input
              size="sm"
              mono
              autoComplete="off"
              spellCheck={false}
              maxLength={20}
              value={draft.gstin}
              onChange={(e) => set("gstin", e.target.value.toUpperCase())}
            />
          </Field>
          <Field size="sm" label={COPY.state} optional error={errors.state} id={fieldId(prefix, "state")}>
            <NativeSelect size="sm" value={draft.state} placeholder={COPY.statePlaceholder} onChange={(e) => set("state", e.target.value)}>
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Field size="sm" label={COPY.address} optional error={errors.address} id={fieldId(prefix, "address")}>
          <Input size="sm" autoComplete="off" maxLength={300} value={draft.address} onChange={(e) => set("address", e.target.value)} />
        </Field>
        <div className={twoColumns}>
          <Field size="sm" label={COPY.city} optional error={errors.city} id={fieldId(prefix, "city")}>
            <Input size="sm" autoComplete="off" maxLength={80} value={draft.city} onChange={(e) => set("city", e.target.value)} />
          </Field>
          <Field size="sm" label={COPY.pin} optional error={errors.pin} id={fieldId(prefix, "pin")}>
            <Input size="sm" inputMode="numeric" autoComplete="off" maxLength={6} value={draft.pin} onChange={(e) => set("pin", e.target.value)} />
          </Field>
        </div>
      </fieldset>
    </>
  );
}

/** A checkbox row with its label, hint and error tied to it (Field cannot wrap Radix checkboxes). */
export function CheckboxField({
  id,
  label,
  hint,
  error,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div className="grid gap-1">
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          className="mt-px"
          checked={checked}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={[errorId, hintId].filter(Boolean).join(" ") || undefined}
          onCheckedChange={(value) => onChange(value === true)}
        />
        <label htmlFor={id} className="cursor-pointer text-[13px] font-bold text-ink">
          {label}
        </label>
      </div>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
      {hint ? (
        <p id={hintId} className="m-0 pl-[26px] text-[12px] text-ink-2">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** "Reason (saved to the audit log)", required on every customer write. */
export function ReasonField({ prefix, value, error, onChange }: { prefix: string; value: string; error?: string; onChange: (value: string) => void }) {
  return (
    <Field size="sm" label={COPY.reason} required error={error} id={fieldId(prefix, "reason")}>
      <Textarea size="sm" rows={2} maxLength={500} value={value} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}
