"use client";

import * as React from "react";
import { adminToast } from "@/components/admin/admin-toaster";
import { AdminDrawer, DrawerSubmit } from "@/components/admin/drawer";
import type { AdminProductDetail, CatalogFormOptions } from "@/lib/admin/catalog/types";
import { apiFetch } from "@/lib/client/api";
import { EMPTY_PRODUCT, ListingBasics, ListingDetails, productPayload, type ProductFormValue } from "./product-form";
import { fieldErrorsOf, FormAlert, formErrorOf, replaceParams } from "./shared";

/** Search parameter of the "New product" drawer (?new=product). */
export const NEW_PARAM = "new";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: CatalogFormOptions;
  onCreated: () => void;
};

/**
 * "New product" (products.manage): creates a DRAFT with empty page content, then opens it in the product drawer so
 * content, plans and a release can follow before publishing.
 */
export function ProductCreateDrawer({ open, onOpenChange, options, onCreated }: Props) {
  return (
    <AdminDrawer open={open} onOpenChange={onOpenChange} kind="New product" title="Create a draft product" subtitle="Drafts stay off the storefront until you publish them.">
      {open ? <CreateForm options={options} onCreated={onCreated} /> : null}
    </AdminDrawer>
  );
}

function CreateForm({ options, onCreated }: Pick<Props, "options" | "onCreated">) {
  const uid = React.useId();
  const [value, setValue] = React.useState<ProductFormValue>({ ...EMPTY_PRODUCT, categoryId: options.categories[0]?.id ?? "" });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const res = await apiFetch<{ product: AdminProductDetail }>("/api/admin/products", { method: "POST", body: { id: value.id.trim(), ...productPayload(value) } });
      adminToast.success("Draft product created \u2014 add plans and a release before publishing");
      replaceParams({ new: null, id: res.product.id });
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
          Storefront listing
        </h3>
        <ListingDetails value={value} onChange={setValue} errors={errors} idPrefix={uid} options={options} mode="create" />
        <ListingBasics value={value} onChange={setValue} errors={errors} idPrefix={uid} />
      </section>
      <FormAlert>{formError}</FormAlert>
      <DrawerSubmit disabled={busy} aria-busy={busy || undefined}>
        Create draft
      </DrawerSubmit>
    </form>
  );
}
