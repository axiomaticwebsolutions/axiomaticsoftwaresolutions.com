"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { DisabledAction } from "@/components/account/disabled-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { toast } from "@/components/ui/sonner";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { BILLING_STATE_OPTIONS, type BillingDetails } from "@/lib/validation/portal";
import {
  BILLING_API_PATH,
  BILLING_COPY,
  BILLING_LABELS,
  billingFormValues,
  billingPatchBody,
  billingServerErrors,
  firstInvalidField,
  gstinHelper,
  gstinInput,
  validateBillingForm,
  type BillingFieldKey,
  type BillingFormErrors,
  type BillingFormValues,
  type BillingResponse,
  type HelperLine,
  type HelperTone,
} from "./billing-model";

/** Prototype inputs: 40px, radius 10, 12px padding, 14px/600. */
const INPUT = "h-10 rounded-10 px-3 text-[14px] font-semibold";
/** Prototype "Save details": 9px 16px, radius 10, 16px/700. */
const SAVE = "h-auto rounded-10 px-4 py-[9px] text-[16px] leading-[normal]";
const LINE_TONE: Readonly<Record<HelperTone, string>> = { neutral: "text-ink-2", valid: "text-sage-fg", error: "text-danger" };

type ControlProps = { id?: string; "aria-invalid"?: boolean; "aria-describedby"?: string };

/** Label (13px/700) + control + one message line (error, or the live GSTIN line), wired with aria. */
function BillingField({
  id,
  label,
  line,
  className,
  children,
}: {
  id: string;
  label: string;
  line: HelperLine | null;
  className?: string;
  children: React.ReactElement<ControlProps>;
}) {
  const messageId = `${id}-message`;
  const control = React.cloneElement(children, {
    id,
    "aria-invalid": line?.tone === "error" ? true : undefined,
    "aria-describedby": line ? messageId : undefined,
  });
  return (
    <div className={cn("grid min-w-0 content-start gap-[5px]", className)}>
      <label htmlFor={id} className="text-[13px] font-bold text-ink">
        {label}
      </label>
      {control}
      {line ? (
        <p id={messageId} className={cn("m-0 text-[12.5px] font-semibold", LINE_TONE[line.tone])}>
          {line.message}
        </p>
      ) : null}
    </div>
  );
}

export type BillingDetailsFormProps = {
  details: BillingDetails;
  /** Team permission billing.edit (Owner, Billing admin); without it the form is read-only. */
  canEdit: boolean;
};

/**
 * "Business & tax details" card: legal name, GSTIN (upper-cased, live format and state check), State / UT (select of
 * the GST states), registered address, city, PIN. Errors show after the first save attempt and then update live; the
 * first invalid field gets focus. Saves with PATCH /api/account/billing, then refreshes the shell (business name).
 */
export function BillingDetailsForm({ details, canEdit }: BillingDetailsFormProps) {
  const router = useRouter();
  const uid = React.useId();
  const fieldId = (key: BillingFieldKey) => `${uid}-${key}`;
  const [values, setValues] = React.useState<BillingFormValues>(() => billingFormValues(details));
  const [tried, setTried] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<BillingFormErrors>({});
  const [saving, setSaving] = React.useState(false);

  const errors: BillingFormErrors = { ...serverErrors, ...(tried ? validateBillingForm(values) : {}) };
  const errorLine = (key: BillingFieldKey): HelperLine | null => {
    const message = errors[key];
    return message ? { message, tone: "error" } : null;
  };

  const focusField = (key: BillingFieldKey | null) => {
    if (!key) return;
    window.requestAnimationFrame(() => document.getElementById(fieldId(key))?.focus());
  };

  const update = (key: BillingFieldKey) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = key === "gstin" ? gstinInput(event.target.value) : event.target.value;
    setValues((current) => ({ ...current, [key]: value }));
    // The GSTIN/State cross-check can be fixed from either field.
    const cleared: readonly BillingFieldKey[] = key === "gstin" || key === "state" ? ["gstin", "state"] : [key];
    setServerErrors((current) => {
      if (cleared.every((k) => current[k] === undefined)) return current;
      const next = { ...current };
      for (const k of cleared) delete next[k];
      return next;
    });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canEdit || saving) return;
    const found = validateBillingForm(values);
    if (firstInvalidField(found)) {
      setTried(true);
      focusField(firstInvalidField({ ...serverErrors, ...found }));
      return;
    }
    setSaving(true);
    try {
      const saved = await apiFetch<BillingResponse>(BILLING_API_PATH, { method: "PATCH", body: billingPatchBody(values) });
      setValues(billingFormValues(saved.details));
      setTried(false);
      setServerErrors({});
      toast.success(BILLING_COPY.saved);
      // The business name also shows in the shell (switcher, breadcrumb) and the invoice contacts may have changed.
      router.refresh();
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 422) {
        const fieldErrors = billingServerErrors(error.fieldErrors);
        const first = firstInvalidField(fieldErrors);
        if (first) {
          setServerErrors(fieldErrors);
          focusField(first);
          return;
        }
      }
      toast.error(error instanceof ApiClientError ? error.message : BILLING_COPY.saveFailed);
    } finally {
      setSaving(false);
    }
  };

  const readOnly = !canEdit;
  const input = (key: Exclude<BillingFieldKey, "state">, extra: React.ComponentProps<typeof Input> = {}) => (
    <Input value={values[key]} onChange={update(key)} readOnly={readOnly} className={INPUT} {...extra} />
  );
  const gstinLine = errorLine("gstin") ?? (canEdit ? gstinHelper(values.gstin, values.state) : null);

  return (
    <form onSubmit={submit} noValidate aria-labelledby={`${uid}-title`} className="min-w-0 rounded-16 border border-line-alt bg-surface">
      <div className="border-b border-line-subtle px-[18px] py-3.5">
        <h2 id={`${uid}-title`} className="m-0 text-[15px] font-extrabold">
          {BILLING_COPY.formTitle}
        </h2>
        <p className="mb-0 mt-0.5 text-[13px] text-ink-2">{BILLING_COPY.formDescription}</p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,200px),1fr))] gap-3.5 px-[18px] py-4">
        <BillingField id={fieldId("legalName")} label={BILLING_LABELS.legalName} line={errorLine("legalName")} className="col-span-full">
          {input("legalName", { autoComplete: "organization" })}
        </BillingField>
        <BillingField id={fieldId("gstin")} label={BILLING_LABELS.gstin} line={gstinLine}>
          {input("gstin", { mono: true, maxLength: 20, autoComplete: "off", autoCapitalize: "characters", spellCheck: false })}
        </BillingField>
        <BillingField id={fieldId("state")} label={BILLING_LABELS.state} line={errorLine("state")}>
          {readOnly ? (
            <Input value={values.state || "—"} readOnly className={INPUT} />
          ) : (
            <NativeSelect value={values.state} onChange={update("state")} placeholder={BILLING_COPY.statePlaceholder} autoComplete="address-level1" className={cn(INPUT, "pr-9")}>
              {BILLING_STATE_OPTIONS.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </NativeSelect>
          )}
        </BillingField>
        <BillingField id={fieldId("address")} label={BILLING_LABELS.address} line={errorLine("address")} className="col-span-full">
          {input("address", { autoComplete: "street-address" })}
        </BillingField>
        <BillingField id={fieldId("city")} label={BILLING_LABELS.city} line={errorLine("city")}>
          {input("city", { autoComplete: "address-level2" })}
        </BillingField>
        <BillingField id={fieldId("pin")} label={BILLING_LABELS.pin} line={errorLine("pin")}>
          {input("pin", { inputMode: "numeric", maxLength: 6, autoComplete: "postal-code" })}
        </BillingField>
      </div>
      <div className="flex justify-end border-t border-line-subtle px-[18px] py-3">
        {canEdit ? (
          <Button type="submit" loading={saving} className={SAVE}>
            {BILLING_COPY.save}
          </Button>
        ) : (
          <DisabledAction perm="billing.edit" className={SAVE}>
            {BILLING_COPY.save}
          </DisabledAction>
        )}
      </div>
    </form>
  );
}
