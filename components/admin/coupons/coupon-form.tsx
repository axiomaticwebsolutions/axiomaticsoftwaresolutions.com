"use client";

import * as React from "react";
import { DrawerSubmit } from "@/components/admin/drawer";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  COUPON_LABEL_MAX,
  COUPON_PLAN_TYPE_LABELS,
  COUPON_PLAN_TYPES,
  type CouponPlanType,
} from "@/lib/admin/coupons/model";
import type { CouponDraft } from "./coupon-draft";

export type CouponProductOption = { id: string; name: string };

type Props = {
  mode: "create" | "edit";
  draft: CouponDraft;
  onChange: (draft: CouponDraft) => void;
  products: readonly CouponProductOption[];
  errors: Record<string, string>;
  formError: string | null;
  busy: boolean;
  onSubmit: () => void;
  idPrefix: string;
};

function toggle<T extends string>(list: readonly T[], value: T, on: boolean): T[] {
  return on ? [...list.filter((v) => v !== value), value] : list.filter((v) => v !== value);
}

function CheckGroup<T extends string>({
  legend,
  hint,
  options,
  selected,
  onChange,
  error,
  id,
}: {
  legend: string;
  hint: string;
  options: readonly { value: T; label: string }[];
  selected: readonly T[];
  onChange: (next: T[]) => void;
  error?: string;
  id: string;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <fieldset
      aria-describedby={[error ? errorId : null, hintId].filter(Boolean).join(" ")}
      aria-invalid={error ? true : undefined}
      className="m-0 grid min-w-0 gap-1.5 border-0 p-0"
    >
      <legend className="mb-1.5 p-0 text-[12.5px] font-bold text-ink">{legend}</legend>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,190px),1fr))] gap-x-3 gap-y-1.5">
        {options.map((o) => (
          <label key={o.value} className="flex min-w-0 cursor-pointer items-center gap-2 text-[13px] font-semibold">
            <Checkbox size="sm" checked={selected.includes(o.value)} onCheckedChange={(v) => onChange(toggle(selected, o.value, v === true))} />
            <span className="min-w-0 break-words">{o.label}</span>
          </label>
        ))}
      </div>
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
      <p id={hintId} className="m-0 text-[12px] text-ink-2">
        {hint}
      </p>
    </fieldset>
  );
}

/**
 * Coupon rules (drawer edit card "Rules" and the "New coupon" form): discount, checkout label, minimum order, products,
 * plan types, IST dates and the redemption limit; the code only when creating (it never changes afterwards).
 */
export function CouponForm({ mode, draft, onChange, products, errors, formError, busy, onSubmit, idPrefix }: Props) {
  const set = <K extends keyof CouponDraft>(key: K, value: CouponDraft[K]) => onChange({ ...draft, [key]: value });
  const planOptions = COUPON_PLAN_TYPES.map((t) => ({ value: t, label: COUPON_PLAN_TYPE_LABELS[t] }));
  return (
    <form
      noValidate
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {formError ? (
        <div role="alert" className="rounded-8 bg-pink-bg px-2.5 py-2 text-[13px] font-bold text-pink-fg">
          {formError}
        </div>
      ) : null}
      {mode === "create" ? (
        <Field label="Code" size="sm" error={errors.code} hint="Letters, digits and hyphens. Customers type it at checkout; it can’t be changed later." id={`${idPrefix}-code`}>
          <Input
            size="sm"
            mono
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            value={draft.code}
            onChange={(e) => set("code", e.target.value.toUpperCase().replace(/\s+/g, ""))}
          />
        </Field>
      ) : null}
      <div className="grid gap-2.5 min-[26.25rem]:grid-cols-2">
        <Field label="Discount type" size="sm" error={errors.type} id={`${idPrefix}-type`}>
          <NativeSelect size="sm" value={draft.type} onChange={(e) => set("type", e.target.value === "FLAT" ? "FLAT" : "PERCENT")}>
            <option value="PERCENT">Percent off</option>
            <option value="FLAT">Amount off (₹)</option>
          </NativeSelect>
        </Field>
        <Field label={draft.type === "PERCENT" ? "Percent off" : "Amount off (₹)"} size="sm" error={errors.value} id={`${idPrefix}-value`}>
          <Input size="sm" inputMode={draft.type === "PERCENT" ? "numeric" : "decimal"} value={draft.value} onChange={(e) => set("value", e.target.value)} />
        </Field>
      </div>
      <Field
        label="Checkout label"
        size="sm"
        error={errors.label}
        hint="Shown to the buyer when the code applies, e.g. “10% off orders above ₹2,000”."
        id={`${idPrefix}-label`}
      >
        <Input size="sm" maxLength={COUPON_LABEL_MAX} value={draft.label} onChange={(e) => set("label", e.target.value)} />
      </Field>
      <div className="grid gap-2.5 min-[26.25rem]:grid-cols-2">
        <Field label="Minimum order (₹)" size="sm" optional error={errors.minSubtotal} hint="Cart subtotal before GST." id={`${idPrefix}-min`}>
          <Input size="sm" inputMode="decimal" value={draft.minSubtotal} onChange={(e) => set("minSubtotal", e.target.value)} />
        </Field>
        <Field label="Redemption limit" size="sm" optional error={errors.maxRedemptions} hint="Empty for no limit." id={`${idPrefix}-limit`}>
          <Input size="sm" inputMode="numeric" value={draft.maxRedemptions} onChange={(e) => set("maxRedemptions", e.target.value)} />
        </Field>
      </div>
      <div className="grid gap-2.5 min-[26.25rem]:grid-cols-2">
        <Field label="Starts" size="sm" error={errors.startsOn} hint="From 00:00 IST." id={`${idPrefix}-starts`}>
          <Input size="sm" type="date" value={draft.startsOn} onChange={(e) => set("startsOn", e.target.value)} />
        </Field>
        <Field label="Ends" size="sm" error={errors.endsOn} hint="Until 23:59 IST." id={`${idPrefix}-ends`}>
          <Input size="sm" type="date" value={draft.endsOn} onChange={(e) => set("endsOn", e.target.value)} />
        </Field>
      </div>
      <CheckGroup
        id={`${idPrefix}-products`}
        legend="Products"
        hint="Leave all unticked to apply to every product."
        options={products.map((p) => ({ value: p.id, label: p.name }))}
        selected={draft.productIds}
        onChange={(next) => set("productIds", next)}
        error={errors.productIds}
      />
      <CheckGroup<CouponPlanType>
        id={`${idPrefix}-plans`}
        legend="Plan types"
        hint="Leave all unticked to apply to every plan type."
        options={planOptions}
        selected={draft.planTypes}
        onChange={(next) => set("planTypes", next)}
        error={errors.planTypes}
      />
      <DrawerSubmit loading={busy}>{mode === "create" ? "Create coupon" : "Save changes"}</DrawerSubmit>
    </form>
  );
}
