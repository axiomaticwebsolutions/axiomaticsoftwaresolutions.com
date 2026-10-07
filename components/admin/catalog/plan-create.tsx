"use client";

import * as React from "react";
import { adminToast } from "@/components/admin/admin-toaster";
import { AdminDrawer, DrawerSubmit } from "@/components/admin/drawer";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { PLAN_TYPE_LABELS } from "@/lib/admin/catalog/model";
import { PLAN_TYPES } from "@/lib/admin/catalog/schemas";
import type { AdminPlanDetail, CatalogFormOptions, PlanTypeKey } from "@/lib/admin/catalog/types";
import { apiFetch } from "@/lib/client/api";
import { EMPTY_PLAN, planPayload, PricingFields, TermsFields, type PlanFormValue } from "./plan-form";
import { fieldErrorsOf, FormAlert, formErrorOf, FormGrid, replaceParams } from "./shared";

export const NEW_PLAN_PARAM = "new";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: CatalogFormOptions;
  /** Preselected product (the list's product filter). */
  productId?: string;
  onCreated: () => void;
};

/** "New plan" (pricing.manage): a plan of one of the six types for a product, checked against the type's rules. */
export function PlanCreateDrawer({ open, onOpenChange, options, productId, onCreated }: Props) {
  return (
    <AdminDrawer open={open} onOpenChange={onOpenChange} kind="New plan" title="Add a plan" subtitle="New plans go on sale straight away on published products.">
      {open ? <CreateForm options={options} productId={productId} onCreated={onCreated} /> : null}
    </AdminDrawer>
  );
}

function CreateForm({ options, productId, onCreated }: Pick<Props, "options" | "productId" | "onCreated">) {
  const uid = React.useId();
  const [product, setProduct] = React.useState(productId && options.products.some((p) => p.id === productId) ? productId : (options.products[0]?.id ?? ""));
  const [type, setType] = React.useState<PlanTypeKey>("ANNUAL");
  const [id, setId] = React.useState("");
  const [value, setValue] = React.useState<PlanFormValue>(EMPTY_PLAN);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const { body, errors: local } = planPayload(value, type);
    if (Object.keys(local).length > 0) {
      setErrors(local);
      setFormError("Please fix the highlighted fields.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await apiFetch<{ plan: AdminPlanDetail }>("/api/admin/plans", { method: "POST", body: { id: id.trim(), productId: product, type, ...body } });
      adminToast.success("Plan created");
      replaceParams({ new: null, id: res.plan.id });
      onCreated();
    } catch (error) {
      setErrors(fieldErrorsOf(error));
      setFormError(formErrorOf(error));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-3">
      <section aria-labelledby={`${uid}-h`} className="grid gap-2.5 rounded-12 border border-line-subtle p-3">
        <h3 id={`${uid}-h`} className="m-0 text-[12.5px] font-extrabold">
          Plan
        </h3>
        <FormGrid>
          <Field size="sm" label="Product" error={errors.productId} id={`${uid}-product`}>
            <NativeSelect size="sm" value={product} onChange={(e) => setProduct(e.target.value)}>
              {options.products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field size="sm" label="Type" hint="Fixed once created." error={errors.type} id={`${uid}-type`}>
            <NativeSelect size="sm" value={type} onChange={(e) => setType(e.target.value as PlanTypeKey)}>
              {PLAN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PLAN_TYPE_LABELS[t]}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </FormGrid>
        <Field size="sm" label="Plan id" hint="Lower-case words joined by hyphens, e.g. med-annual-3pc. It can’t change later." error={errors.id} id={`${uid}-id`}>
          <Input size="sm" mono value={id} maxLength={60} autoComplete="off" onChange={(e) => setId(e.target.value.toLowerCase())} />
        </Field>
        <TermsFields value={value} onChange={setValue} errors={errors} type={type} idPrefix={uid} />
      </section>
      <section aria-labelledby={`${uid}-p`} className="grid gap-2.5 rounded-12 border border-line-subtle p-3">
        <h3 id={`${uid}-p`} className="m-0 text-[12.5px] font-extrabold">
          Pricing & limits
        </h3>
        <PricingFields value={value} onChange={setValue} errors={errors} type={type} idPrefix={uid} />
      </section>
      <FormAlert>{formError}</FormAlert>
      <DrawerSubmit disabled={busy} aria-busy={busy || undefined}>
        Create plan
      </DrawerSubmit>
    </form>
  );
}
