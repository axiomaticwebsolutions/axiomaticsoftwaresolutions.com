"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useAdmin } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { Icon, type IconName } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { TONE_LABELS } from "@/lib/admin/catalog/model";
import { CATALOG_TONES, isKnownIcon } from "@/lib/admin/catalog/schemas";
import type { AdminCategoryRow, CatalogTone } from "@/lib/admin/catalog/types";
import { apiFetch } from "@/lib/client/api";
import { READ_ONLY_FOR_ROLE } from "@/lib/rbac";
import { fieldErrorsOf, FormAlert, formErrorOf, FormGrid } from "./shared";

/** Search parameter of the category dialog: ?category=new or ?category=<id>. */
export const CATEGORY_PARAM = "category";

type Props = {
  /** "new", an existing category's id, or null (closed). */
  target: string | null;
  categories: readonly AdminCategoryRow[];
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
};

type Value = { id: string; name: string; blurb: string; tone: CatalogTone; icon: string; sortOrder: string };

/** Create or edit a storefront category (products.manage; read only otherwise); empty categories can be deleted. */
export function CategoryDialog({ target, categories, onOpenChange, onChanged }: Props) {
  const existing = target && target !== "new" ? (categories.find((c) => c.id === target) ?? null) : null;
  const open = target === "new" || existing !== null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        {open ? <CategoryForm key={existing?.id ?? "new"} existing={existing} onDone={() => onOpenChange(false)} onChanged={onChanged} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function CategoryForm({ existing, onDone, onChanged }: { existing: AdminCategoryRow | null; onDone: () => void; onChanged: () => void }) {
  const { can } = useAdmin();
  const readOnly = !can("products.manage");
  const uid = React.useId();
  const [value, setValue] = React.useState<Value>(
    existing
      ? { id: existing.id, name: existing.name, blurb: existing.blurb ?? "", tone: existing.tone, icon: existing.icon, sortOrder: String(existing.sortOrder) }
      : { id: "", name: "", blurb: "", tone: "sage", icon: "", sortOrder: "0" },
  );
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const set = <K extends keyof Value>(key: K, v: Value[K]) => setValue({ ...value, [key]: v });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || readOnly) return;
    setBusy(true);
    setFormError(null);
    const order = value.sortOrder.trim();
    const body = {
      name: value.name,
      blurb: value.blurb.trim() === "" ? null : value.blurb,
      tone: value.tone,
      icon: value.icon.trim(),
      sortOrder: /^\d{1,4}$/.test(order) ? Number(order) : -1,
    };
    try {
      if (existing) {
        const res = await apiFetch<{ changed: boolean }>(`/api/admin/categories/${encodeURIComponent(existing.id)}`, { method: "PATCH", body });
        adminToast.success(res.changed ? "Category updated" : "No changes to save");
      } else {
        await apiFetch("/api/admin/categories", { method: "POST", body: { id: value.id.trim(), ...body } });
        adminToast.success("Category created");
      }
      onChanged();
      onDone();
    } catch (error) {
      setErrors(fieldErrorsOf(error));
      setFormError(formErrorOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(reason: string) {
    if (!existing) return;
    await apiFetch(`/api/admin/categories/${encodeURIComponent(existing.id)}`, { method: "DELETE", body: { reason } });
    adminToast.success("Category deleted");
    onChanged();
    onDone();
  }

  const icon = value.icon.trim();
  const inUse = (existing?.productCount ?? 0) > 0;
  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>{existing ? `Edit ${existing.name}` : "New category"}</DialogTitle>
        <DialogDescription>Categories group products in the catalog filters and on the home page.</DialogDescription>
      </DialogHeader>
      {readOnly ? (
        <p className="m-0 flex items-center gap-1 text-[12.5px] font-extrabold text-danger">
          <Icon name="lock" size={15} />
          {READ_ONLY_FOR_ROLE}
        </p>
      ) : null}
      <fieldset disabled={readOnly} className="m-0 grid min-w-0 gap-2.5 border-0 p-0">
        <FormGrid>
          <Field size="sm" label="Category id" hint={existing ? "Used in catalog links; it can\u2019t change." : "Used in catalog links, e.g. clinics."} error={errors.id} id={`${uid}-id`}>
            <Input size="sm" mono value={value.id} readOnly={!!existing} tabIndex={existing ? -1 : undefined} maxLength={40} autoComplete="off" onChange={(e) => set("id", e.target.value.toLowerCase())} />
          </Field>
          <Field size="sm" label="Name" error={errors.name} id={`${uid}-name`}>
            <Input size="sm" value={value.name} maxLength={60} onChange={(e) => set("name", e.target.value)} />
          </Field>
        </FormGrid>
        <Field size="sm" label="Description" optional error={errors.blurb} id={`${uid}-blurb`}>
          <Input size="sm" value={value.blurb} maxLength={200} onChange={(e) => set("blurb", e.target.value)} />
        </Field>
        <FormGrid>
          <Field size="sm" label="Icon" hint="A Material Symbols name." error={errors.icon} id={`${uid}-icon`}>
            {(control) => (
              <span className="flex items-center gap-2">
                <Input {...control} size="sm" mono value={value.icon} maxLength={60} autoComplete="off" onChange={(e) => set("icon", e.target.value)} />
                <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-8 border border-line-subtle bg-bg text-ink-2">
                  {isKnownIcon(icon) ? <Icon name={icon as IconName} size={20} /> : null}
                </span>
              </span>
            )}
          </Field>
          <FormGrid>
            <Field size="sm" label="Colour" error={errors.tone} id={`${uid}-tone`}>
              <NativeSelect size="sm" value={value.tone} onChange={(e) => set("tone", e.target.value as CatalogTone)}>
                {CATALOG_TONES.map((t) => (
                  <option key={t} value={t}>
                    {TONE_LABELS[t]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field size="sm" label="Order" error={errors.sortOrder} id={`${uid}-order`}>
              <Input size="sm" inputMode="numeric" value={value.sortOrder} maxLength={4} onChange={(e) => set("sortOrder", e.target.value)} />
            </Field>
          </FormGrid>
        </FormGrid>
      </fieldset>
      <FormAlert>{formError}</FormAlert>
      <DialogFooter className="sm:justify-between">
        {existing ? (
          <AdminAction
            perm="products.manage"
            variant="danger"
            size="sm"
            icon="delete"
            disabledReason={inUse ? "Move its products to another category first" : undefined}
            onClick={() => setConfirmDelete(true)}
          >
            Delete category
          </AdminAction>
        ) : (
          <span />
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="secondary" size="sm" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" disabled={busy || readOnly} aria-busy={busy || undefined}>
            {existing ? "Save changes" : "Create category"}
          </Button>
        </div>
      </DialogFooter>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${existing?.name ?? "this category"}?`}
        description="It no longer appears in the catalog filters. This can’t be undone."
        confirmLabel="Delete category"
        tone="danger"
        icon="delete"
        onConfirm={({ reason }) => remove(reason)}
      />
    </form>
  );
}
