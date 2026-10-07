"use client";

import * as React from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FormErrorSummary, type FormError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";

type Values = { name: string; email: string; mobile: string; pin: string; state: string; agree: boolean };
type FieldName = keyof Values;

const FIELD_IDS: Record<FieldName, string> = {
  name: "demo-name",
  email: "demo-email",
  mobile: "demo-mobile",
  pin: "demo-pin",
  state: "demo-state",
  agree: "demo-agree-terms",
};

// Demo-only rules with the checkout prototype copy; real forms use the shared Zod schemas in lib/validation.
function validate(values: Values): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {};
  if (!values.name.trim()) errors.name = "Enter your full name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) {
    errors.email = "Enter a valid email address, like name@business.com.";
  }
  if (!/^[6-9]\d{9}$/.test(values.mobile.trim())) errors.mobile = "Enter a 10-digit mobile number.";
  if (!/^[1-9]\d{5}$/.test(values.pin.trim())) errors.pin = "PIN code should be 6 digits.";
  if (!values.state) errors.state = "Select your state or union territory.";
  if (!values.agree) errors.agree = "Please accept the license agreement to continue.";
  return errors;
}

/** Sample form: inline Field errors, aria wiring and the error summary that links to each field. */
export function FormDemo() {
  const [values, setValues] = React.useState<Values>({
    name: "",
    email: "priya@",
    mobile: "",
    pin: "4110",
    state: "",
    agree: false,
  });
  const [errors, setErrors] = React.useState<Partial<Record<FieldName, string>>>({});
  const [attempt, setAttempt] = React.useState(0);
  const [saved, setSaved] = React.useState(false);

  const set = <K extends FieldName>(key: K, value: Values[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setSaved(false);
    // Clear a field's error as soon as it is edited, like the prototypes.
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const summary: FormError[] = (Object.keys(FIELD_IDS) as FieldName[]).flatMap((key) => {
    const message = errors[key];
    return message ? [{ fieldId: FIELD_IDS[key], message }] : [];
  });

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = validate(values);
    setErrors(next);
    setAttempt((n) => n + 1);
    setSaved(Object.keys(next).length === 0);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="grid max-w-[640px] gap-4 rounded-20 border border-line bg-surface p-4 sm:p-6">
      {summary.length > 0 ? <FormErrorSummary key={attempt} errors={summary} /> : null}
      {saved ? (
        <Alert tone="success">
          <AlertTitle>Details saved</AlertTitle>
          <AlertDescription>Every field passed validation.</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={FIELD_IDS.name} label="Full name" error={errors.name}>
          <Input autoComplete="name" value={values.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field id={FIELD_IDS.email} label="Email" error={errors.email} hint="We send the invoice and license here.">
          <Input type="email" autoComplete="email" value={values.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field id={FIELD_IDS.mobile} label="Mobile" error={errors.mobile}>
          <Input
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            value={values.mobile}
            onChange={(e) => set("mobile", e.target.value)}
          />
        </Field>
        <Field id={FIELD_IDS.pin} label="PIN code" error={errors.pin}>
          <Input
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={6}
            value={values.pin}
            onChange={(e) => set("pin", e.target.value)}
          />
        </Field>
        <Field id={FIELD_IDS.state} label="State / UT" error={errors.state} className="sm:col-span-2">
          <NativeSelect placeholder="Select state" value={values.state} onChange={(e) => set("state", e.target.value)}>
            {["Delhi", "Karnataka", "Maharashtra", "Tamil Nadu"].map((state) => (
              <option key={state} value={state}>
                {state}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="grid gap-1.5">
        <div className="flex items-start gap-2.5">
          <Checkbox
            id={FIELD_IDS.agree}
            checked={values.agree}
            aria-invalid={errors.agree ? true : undefined}
            aria-describedby={errors.agree ? `${FIELD_IDS.agree}-error` : undefined}
            onCheckedChange={(value) => set("agree", value === true)}
          />
          <Label htmlFor={FIELD_IDS.agree} className="font-semibold">
            I agree to the license agreement and refund policy.
          </Label>
        </div>
        {errors.agree ? <FieldError id={`${FIELD_IDS.agree}-error`}>{errors.agree}</FieldError> : null}
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="submit">Save details</Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            setErrors({});
            setSaved(false);
          }}
        >
          Clear errors
        </Button>
      </div>
    </form>
  );
}
