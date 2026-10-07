"use client";

import * as React from "react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { paiseToRupeesInput, parseRupeesToPaise } from "@/lib/admin/catalog/model";
import type { AdminPlanDetail, BillingIntervalKey, PlanTypeKey } from "@/lib/admin/catalog/types";
import { FormGrid } from "./shared";

/** Plan fields as typed (strings for numbers, the price in rupees). */
export type PlanFormValue = {
  name: string;
  summary: string;
  includes: string;
  price: string;
  interval: BillingIntervalKey | "";
  trialDays: string;
  deviceLimit: string;
  perUnit: string;
  maxQty: string;
  multiDevice: boolean;
  updatesMonths: string;
  popular: boolean;
  sortOrder: string;
};

export const EMPTY_PLAN: PlanFormValue = {
  name: "",
  summary: "",
  includes: "",
  price: "",
  interval: "",
  trialDays: "",
  deviceLimit: "1",
  perUnit: "",
  maxQty: "",
  multiDevice: false,
  updatesMonths: "",
  popular: false,
  sortOrder: "0",
};

export function planFormValue(p: AdminPlanDetail): PlanFormValue {
  const n = (v: number | null) => (v === null ? "" : String(v));
  return {
    name: p.name,
    summary: p.summary ?? "",
    includes: p.includes.join("\n"),
    price: paiseToRupeesInput(p.pricePaise),
    interval: p.interval ?? "",
    trialDays: n(p.trialDays),
    deviceLimit: n(p.deviceLimit),
    perUnit: p.perUnit ?? "",
    maxQty: n(p.maxQty),
    multiDevice: p.multiDevice,
    updatesMonths: n(p.updatesMonths),
    popular: p.popular,
    sortOrder: String(p.sortOrder),
  };
}

/** Which fields a plan type uses (lib/admin/catalog/schemas.ts planRuleIssues). */
export function planTypeFields(type: PlanTypeKey) {
  const attaches = type === "DEVICE_ADDON" || type === "MAINTENANCE";
  return {
    trialDays: type === "TRIAL",
    interval: type === "SUBSCRIPTION",
    deviceLimit: !attaches,
    perUnit: type === "ONE_TIME" || type === "ANNUAL" || type === "SUBSCRIPTION",
    maxQty: type === "ONE_TIME" || type === "ANNUAL" || type === "SUBSCRIPTION" || type === "DEVICE_ADDON",
    multiDevice: !attaches && type !== "TRIAL",
    updatesMonths: type === "ONE_TIME" || type === "MAINTENANCE",
    price: type !== "TRIAL",
  };
}

const WHOLE = /^\d{1,6}$/;

/**
 * The request body for `type`, or local errors (the prototype's "Enter a valid price."). Fields the type does not use
 * are sent as null; the server checks the remaining rules.
 */
export function planPayload(v: PlanFormValue, type: PlanTypeKey): { body: Record<string, unknown>; errors: Record<string, string> } {
  const use = planTypeFields(type);
  const errors: Record<string, string> = {};
  const int = (key: keyof PlanFormValue, used: boolean): number | null => {
    const raw = String(v[key]).trim();
    if (!used || raw === "") return null;
    if (!WHOLE.test(raw)) {
      errors[key] = "Enter a whole number.";
      return null;
    }
    return Number(raw);
  };
  let pricePaise = 0;
  if (use.price) {
    const parsed = parseRupeesToPaise(v.price);
    if (parsed === null) errors.pricePaise = "Enter a valid price.";
    else pricePaise = parsed;
  }
  const interval = type === "ANNUAL" || type === "MAINTENANCE" ? "YEAR" : use.interval ? v.interval || null : null;
  const sortOrder = int("sortOrder", true);
  const body: Record<string, unknown> = {
    name: v.name,
    summary: v.summary.trim() === "" ? null : v.summary,
    includes: v.includes.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
    pricePaise,
    interval,
    trialDays: int("trialDays", use.trialDays),
    deviceLimit: int("deviceLimit", use.deviceLimit),
    perUnit: use.perUnit && v.perUnit.trim() !== "" ? v.perUnit.trim().toLowerCase() : null,
    maxQty: int("maxQty", use.maxQty),
    multiDevice: use.multiDevice ? v.multiDevice : false,
    updatesMonths: int("updatesMonths", use.updatesMonths),
    popular: v.popular,
    ...(sortOrder === null ? {} : { sortOrder }),
  };
  return { body, errors };
}

export type PlanFieldsProps = {
  value: PlanFormValue;
  onChange: (next: PlanFormValue) => void;
  errors: Record<string, string>;
  type: PlanTypeKey;
  idPrefix: string;
};

const PRICE_HELP = "Changes apply to new purchases and future renewals. Recorded in the audit log.";

/** The prototype's "Pricing & limits" trio: price (excl. GST), device limit, plan summary. */
export function PricingFields({ value, onChange, errors, type, idPrefix }: PlanFieldsProps) {
  const set = <K extends keyof PlanFormValue>(key: K, v: PlanFormValue[K]) => onChange({ ...value, [key]: v });
  const use = planTypeFields(type);
  return (
    <>
      {use.price ? (
        <Field size="sm" label="Price in ₹ (excl. GST)" hint={PRICE_HELP} error={errors.pricePaise} id={`${idPrefix}-price`}>
          <Input size="sm" inputMode="decimal" value={value.price} maxLength={14} onChange={(e) => set("price", e.target.value)} />
        </Field>
      ) : (
        <p className="m-0 text-[12.5px] text-ink-2">Trials are free.</p>
      )}
      {use.deviceLimit ? (
        <Field
          size="sm"
          label="Device limit"
          hint={value.perUnit.trim() ? "Per-unit plans: the quantity bought sets the limit." : undefined}
          error={errors.deviceLimit}
          id={`${idPrefix}-devices`}
        >
          <Input size="sm" inputMode="numeric" value={value.deviceLimit} maxLength={4} onChange={(e) => set("deviceLimit", e.target.value)} />
        </Field>
      ) : null}
      <Field size="sm" label="Plan summary" optional error={errors.summary} id={`${idPrefix}-summary`}>
        <Input size="sm" value={value.summary} maxLength={300} onChange={(e) => set("summary", e.target.value)} />
      </Field>
    </>
  );
}

function SwitchRow({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-8 border border-line-subtle px-3 py-2">
      <span className="grid gap-0.5">
        <label htmlFor={id} className="text-[12.5px] font-bold">
          {label}
        </label>
        {hint ? <span className="text-[12px] text-ink-2">{hint}</span> : null}
      </span>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

/** Name, term and quantity rules for the plan's type, the "includes" list, popular and sort order. */
export function TermsFields({ value, onChange, errors, type, idPrefix }: PlanFieldsProps) {
  const set = <K extends keyof PlanFormValue>(key: K, v: PlanFormValue[K]) => onChange({ ...value, [key]: v });
  const use = planTypeFields(type);
  return (
    <>
      <Field size="sm" label="Plan name" error={errors.name} id={`${idPrefix}-name`}>
        <Input size="sm" value={value.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <FormGrid>
        {use.trialDays ? (
          <Field size="sm" label="Trial length (days)" error={errors.trialDays} id={`${idPrefix}-trial`}>
            <Input size="sm" inputMode="numeric" value={value.trialDays} maxLength={3} onChange={(e) => set("trialDays", e.target.value)} />
          </Field>
        ) : null}
        {use.interval ? (
          <Field size="sm" label="Billing period" error={errors.interval} id={`${idPrefix}-interval`}>
            <NativeSelect size="sm" value={value.interval} placeholder="Choose" onChange={(e) => set("interval", e.target.value as BillingIntervalKey)}>
              <option value="MONTH">Monthly</option>
              <option value="YEAR">Yearly</option>
            </NativeSelect>
          </Field>
        ) : null}
        {use.updatesMonths ? (
          <Field size="sm" label="Updates included (months)" error={errors.updatesMonths} id={`${idPrefix}-updates`}>
            <Input size="sm" inputMode="numeric" value={value.updatesMonths} maxLength={3} onChange={(e) => set("updatesMonths", e.target.value)} />
          </Field>
        ) : null}
        {use.perUnit ? (
          <Field size="sm" label="Priced per" optional hint="One word, e.g. terminal." error={errors.perUnit} id={`${idPrefix}-unit`}>
            <Input size="sm" value={value.perUnit} maxLength={20} onChange={(e) => set("perUnit", e.target.value)} />
          </Field>
        ) : null}
        {use.maxQty ? (
          <Field size="sm" label="Most per purchase" optional error={errors.maxQty} id={`${idPrefix}-max`}>
            <Input size="sm" inputMode="numeric" value={value.maxQty} maxLength={3} onChange={(e) => set("maxQty", e.target.value)} />
          </Field>
        ) : null}
        <Field size="sm" label="Sort order" hint="Lower numbers list first." error={errors.sortOrder} id={`${idPrefix}-order`}>
          <Input size="sm" inputMode="numeric" value={value.sortOrder} maxLength={3} onChange={(e) => set("sortOrder", e.target.value)} />
        </Field>
      </FormGrid>
      <Field size="sm" label="Includes" optional hint="One line per item shown on the plan card." error={errors.includes} id={`${idPrefix}-includes`}>
        <Textarea size="sm" rows={4} className="font-mono text-[12.5px]" value={value.includes} onChange={(e) => set("includes", e.target.value)} />
      </Field>
      {use.multiDevice ? (
        <SwitchRow id={`${idPrefix}-multi`} label="Multi-device" hint="Shown as a multi-device plan." checked={value.multiDevice} onChange={(on) => set("multiDevice", on)} />
      ) : null}
      {errors.multiDevice ? <p className="m-0 text-[13px] font-semibold text-danger">{errors.multiDevice}</p> : null}
      <SwitchRow id={`${idPrefix}-popular`} label="Most popular" hint="Highlights the plan on the product page." checked={value.popular} onChange={(on) => set("popular", on)} />
    </>
  );
}
