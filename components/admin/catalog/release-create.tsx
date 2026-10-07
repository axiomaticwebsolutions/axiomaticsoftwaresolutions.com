"use client";

import * as React from "react";
import { adminToast } from "@/components/admin/admin-toaster";
import { AdminDrawer, DrawerSubmit } from "@/components/admin/drawer";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import type { AdminReleaseDetail, CatalogFormOptions } from "@/lib/admin/catalog/types";
import { apiFetch } from "@/lib/client/api";
import { notesFromText, ReleaseFields } from "./release-form";
import { fieldErrorsOf, FormAlert, formErrorOf, replaceParams } from "./shared";

export const NEW_RELEASE_PARAM = "new";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: CatalogFormOptions;
  productId?: string;
  onCreated: () => void;
};

/** "New release" (releases.manage): a draft for a product; installers are uploaded in its drawer before publishing. */
export function ReleaseCreateDrawer({ open, onOpenChange, options, productId, onCreated }: Props) {
  return (
    <AdminDrawer open={open} onOpenChange={onOpenChange} kind="New release" title="Create a draft release" subtitle="Upload installers in the draft, then publish it.">
      {open ? <CreateForm options={options} productId={productId} onCreated={onCreated} /> : null}
    </AdminDrawer>
  );
}

function CreateForm({ options, productId, onCreated }: Pick<Props, "options" | "productId" | "onCreated">) {
  const uid = React.useId();
  const [product, setProduct] = React.useState(productId && options.products.some((p) => p.id === productId) ? productId : (options.products[0]?.id ?? ""));
  const [value, setValue] = React.useState({ version: "", channel: "stable", notes: "" });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setFormError(null);
    try {
      const res = await apiFetch<{ release: AdminReleaseDetail }>("/api/admin/releases", {
        method: "POST",
        body: { productId: product, version: value.version, channel: value.channel, notes: notesFromText(value.notes) },
      });
      adminToast.success("Draft release created \u2014 upload installers and publish");
      replaceParams({ new: null, id: res.release.id });
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
          Release
        </h3>
        <Field size="sm" label="Product" error={errors.productId} id={`${uid}-product`}>
          <NativeSelect size="sm" value={product} onChange={(e) => setProduct(e.target.value)}>
            {options.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <ReleaseFields
          version={value.version}
          channel={value.channel}
          notes={value.notes}
          onChange={(patch) => setValue({ ...value, ...patch })}
          errors={errors}
          idPrefix={uid}
        />
      </section>
      <FormAlert>{formError}</FormAlert>
      <DrawerSubmit disabled={busy} aria-busy={busy || undefined}>
        Create draft
      </DrawerSubmit>
    </form>
  );
}
