"use client";

import * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { PLATFORM_LABELS, TONE_LABELS } from "@/lib/admin/catalog/model";
import { CATALOG_PLATFORMS, CATALOG_TONES, isKnownIcon } from "@/lib/admin/catalog/schemas";
import type { AdminProductDetail, CatalogFormOptions, CatalogPlatform, CatalogTone } from "@/lib/admin/catalog/types";
import { FormGrid } from "./shared";

export type ProductFormValue = {
  id: string;
  code: string;
  name: string;
  shortName: string;
  tagline: string;
  summary: string;
  categoryId: string;
  platforms: CatalogPlatform[];
  icon: string;
  tone: CatalogTone | "";
  rank: string;
  demoEnabled: boolean;
};

export const EMPTY_PRODUCT: ProductFormValue = {
  id: "",
  code: "",
  name: "",
  shortName: "",
  tagline: "",
  summary: "",
  categoryId: "",
  platforms: ["windows"],
  icon: "",
  tone: "",
  rank: "100",
  demoEnabled: true,
};

export function productFormValue(p: AdminProductDetail): ProductFormValue {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    shortName: p.shortName,
    tagline: p.tagline,
    summary: p.summary,
    categoryId: p.categoryId,
    platforms: p.platforms,
    icon: p.icon,
    tone: p.tone ?? "",
    rank: String(p.rank),
    demoEnabled: p.demoEnabled,
  };
}

/** Request body fields (create adds the id). A malformed rank is sent as -1 so the server explains it. */
export function productPayload(v: ProductFormValue): Record<string, unknown> {
  const raw = v.rank.trim();
  const rank = /^\d{1,4}$/.test(raw) ? Number(raw) : raw === "" ? undefined : -1;
  return {
    code: v.code.trim(),
    name: v.name,
    shortName: v.shortName,
    tagline: v.tagline,
    summary: v.summary,
    categoryId: v.categoryId,
    platforms: v.platforms,
    icon: v.icon.trim(),
    tone: v.tone === "" ? null : v.tone,
    ...(rank === undefined ? {} : { rank }),
    demoEnabled: v.demoEnabled,
  };
}

export type ProductFieldsProps = {
  value: ProductFormValue;
  onChange: (next: ProductFormValue) => void;
  errors: Record<string, string>;
  idPrefix: string;
};

/** Display name, tagline and summary (the prototype's "Storefront listing" fields). */
export function ListingBasics({ value, onChange, errors, idPrefix }: ProductFieldsProps) {
  const set = <K extends keyof ProductFormValue>(key: K, v: ProductFormValue[K]) => onChange({ ...value, [key]: v });
  return (
    <>
      <Field size="sm" label="Display name" error={errors.shortName} id={`${idPrefix}-short`}>
        <Input size="sm" value={value.shortName} maxLength={60} onChange={(e) => set("shortName", e.target.value)} />
      </Field>
      <Field size="sm" label="Tagline" error={errors.tagline} id={`${idPrefix}-tagline`}>
        <Input size="sm" value={value.tagline} maxLength={200} onChange={(e) => set("tagline", e.target.value)} />
      </Field>
      <Field size="sm" label="Summary" error={errors.summary} id={`${idPrefix}-summary`}>
        <Textarea size="sm" rows={6} className="font-mono text-[12.5px]" value={value.summary} maxLength={600} onChange={(e) => set("summary", e.target.value)} />
      </Field>
    </>
  );
}

type DetailsProps = ProductFieldsProps & {
  options: CatalogFormOptions;
  mode: "create" | "edit";
  /** Edit mode: licenses exist, so the prefix is fixed. */
  codeLocked?: boolean;
};

function PlatformChecks({ value, onChange, error, id }: { value: CatalogPlatform[]; onChange: (next: CatalogPlatform[]) => void; error?: string; id: string }) {
  const toggle = (p: CatalogPlatform, on: boolean) => onChange(CATALOG_PLATFORMS.filter((x) => (x === p ? on : value.includes(x))));
  return (
    <fieldset className="m-0 grid min-w-0 gap-1.5 border-0 p-0" aria-describedby={error ? `${id}-error` : undefined}>
      <legend className="mb-1.5 p-0 text-[12.5px] font-bold">Platforms</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {CATALOG_PLATFORMS.map((p) => (
          <label key={p} className="inline-flex cursor-pointer items-center gap-2 text-[13.5px] font-semibold">
            <Checkbox checked={value.includes(p)} onCheckedChange={(on) => toggle(p, on === true)} />
            {PLATFORM_LABELS[p]}
          </label>
        ))}
      </div>
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </fieldset>
  );
}

/** The rest of the listing: name, prefix, category, platforms, icon, colour, rank, demo requests (and the id on create). */
export function ListingDetails({ value, onChange, errors, options, mode, codeLocked = false, idPrefix }: DetailsProps) {
  const set = <K extends keyof ProductFormValue>(key: K, v: ProductFormValue[K]) => onChange({ ...value, [key]: v });
  const icon = value.icon.trim();
  return (
    <>
      {mode === "create" ? (
        <FormGrid>
          <Field size="sm" label="Product id" hint="Used in the page address, e.g. clinic-billing. It can’t change later." error={errors.id} id={`${idPrefix}-id`}>
            <Input size="sm" mono value={value.id} maxLength={60} autoComplete="off" onChange={(e) => set("id", e.target.value.toLowerCase())} />
          </Field>
          <Field size="sm" label="License prefix" hint="3 capital letters that start every key, e.g. CLN." error={errors.code} id={`${idPrefix}-code`}>
            <Input size="sm" mono value={value.code} maxLength={3} autoComplete="off" onChange={(e) => set("code", e.target.value.toUpperCase())} />
          </Field>
        </FormGrid>
      ) : null}
      <Field size="sm" label="Product name" error={errors.name} id={`${idPrefix}-name`}>
        <Input size="sm" value={value.name} maxLength={120} onChange={(e) => set("name", e.target.value)} />
      </Field>
      <FormGrid>
        <Field size="sm" label="Category" error={errors.categoryId} id={`${idPrefix}-category`}>
          <NativeSelect size="sm" value={value.categoryId} placeholder="Choose a category" onChange={(e) => set("categoryId", e.target.value)}>
            {options.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field size="sm" label="Rank" hint="Lower numbers list first." error={errors.rank} id={`${idPrefix}-rank`}>
          <Input size="sm" inputMode="numeric" value={value.rank} maxLength={4} onChange={(e) => set("rank", e.target.value)} />
        </Field>
      </FormGrid>
      {mode === "edit" ? (
        <Field
          size="sm"
          label="License prefix"
          hint={codeLocked ? "Fixed: licenses have been issued with this prefix." : "3 capital letters. It becomes fixed once a license is issued."}
          error={errors.code}
          id={`${idPrefix}-code`}
        >
          <Input size="sm" mono value={value.code} maxLength={3} readOnly={codeLocked} onChange={(e) => set("code", e.target.value.toUpperCase())} />
        </Field>
      ) : null}
      <PlatformChecks value={value.platforms} onChange={(next) => set("platforms", next)} error={errors.platforms} id={`${idPrefix}-platforms`} />
      <FormGrid>
        <Field size="sm" label="Icon" hint="A Material Symbols name, e.g. receipt_long." error={errors.icon} id={`${idPrefix}-icon`}>
          {(control) => (
            <span className="flex items-center gap-2">
              <Input {...control} size="sm" mono value={value.icon} maxLength={60} autoComplete="off" onChange={(e) => set("icon", e.target.value)} />
              <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-8 border border-line-subtle bg-bg text-ink-2">
                {isKnownIcon(icon) ? <Icon name={icon as IconName} size={20} /> : null}
              </span>
            </span>
          )}
        </Field>
        <Field size="sm" label="Colour" error={errors.tone} id={`${idPrefix}-tone`}>
          <NativeSelect size="sm" value={value.tone} onChange={(e) => set("tone", e.target.value as CatalogTone | "")}>
            <option value="">Same as the category</option>
            {CATALOG_TONES.map((t) => (
              <option key={t} value={t}>
                {TONE_LABELS[t]}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </FormGrid>
      <div className="flex items-center justify-between gap-3 rounded-8 border border-line-subtle px-3 py-2">
        <span className="grid gap-0.5">
          <label htmlFor={`${idPrefix}-demo`} className="text-[12.5px] font-bold">
            Demo requests
          </label>
          <span className="text-[12px] text-ink-2">Shows “Book a demo” on the product page.</span>
        </span>
        <Switch id={`${idPrefix}-demo`} checked={value.demoEnabled} onCheckedChange={(on) => set("demoEnabled", on)} />
      </div>
    </>
  );
}
