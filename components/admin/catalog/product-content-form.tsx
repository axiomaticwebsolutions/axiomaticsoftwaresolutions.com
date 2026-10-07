"use client";

import * as React from "react";
import { DrawerSubmit } from "@/components/admin/drawer";
import { adminToast } from "@/components/admin/admin-toaster";
import { Checkbox } from "@/components/ui/checkbox";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  CONTENT_LINE_HINTS,
  formatBenefitLines,
  formatFeatureLines,
  formatRequirementLines,
  parseBenefitLines,
  parseFeatureLines,
  parseRequirementLines,
} from "@/lib/admin/catalog/model";
import { MAX_RELATED } from "@/lib/admin/catalog/schemas";
import type { AdminProductDetail, CatalogFormOptions } from "@/lib/admin/catalog/types";
import { apiFetch } from "@/lib/client/api";
import { fieldErrorsOf, FormAlert, formErrorOf } from "./shared";

type Props = {
  product: AdminProductDetail;
  options: CatalogFormOptions;
  readOnly: boolean;
  onSaved: (product: AdminProductDetail) => void;
};

const LIMITS = { features: [1, 12], benefits: [0, 6], requirements: [0, 12] } as const;
type Part = keyof typeof LIMITS;

/** "content.features.2.title" -> "Line 3: <message>" on the features box. */
function contentErrors(fieldErrors: Record<string, string>): Partial<Record<Part | "relatedIds", string>> {
  const out: Partial<Record<Part | "relatedIds", string>> = {};
  for (const [key, message] of Object.entries(fieldErrors)) {
    const m = /^content\.(features|benefits|requirements)(?:\.(\d+))?/.exec(key);
    if (m) {
      const part = m[1] as Part;
      out[part] ??= m[2] !== undefined ? `Line ${Number(m[2]) + 1}: ${message}` : message;
    } else if (key.startsWith("relatedIds")) out.relatedIds ??= message;
  }
  return out;
}

/**
 * Product page content (features, benefits, system requirements) as one item per line, plus related products.
 * Validated here line by line and again on the server with productContentSchema (+ known icons).
 */
export function ProductContentForm({ product, options, readOnly, onSaved }: Props) {
  const [text, setText] = React.useState<Record<Part, string>>({
    features: formatFeatureLines(product.content.features),
    benefits: formatBenefitLines(product.content.benefits),
    requirements: formatRequirementLines(product.content.requirements),
  });
  const [related, setRelated] = React.useState<string[]>(product.relatedIds);
  const [errors, setErrors] = React.useState<Partial<Record<Part | "relatedIds", string>>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const others = options.products.filter((p) => p.id !== product.id);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || readOnly) return;
    const parsed = { features: parseFeatureLines(text.features), benefits: parseBenefitLines(text.benefits), requirements: parseRequirementLines(text.requirements) };
    const local: Partial<Record<Part | "relatedIds", string>> = {};
    for (const part of Object.keys(LIMITS) as Part[]) {
      const [min, max] = LIMITS[part];
      const result = parsed[part];
      if (result.issues[0]) local[part] = result.issues[0].message;
      else if (result.items.length < min) local[part] = "Add at least one feature.";
      else if (result.items.length > max) local[part] = `List up to ${max}.`;
    }
    setErrors(local);
    if (Object.keys(local).length > 0) {
      setFormError("Please fix the highlighted fields.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      const res = await apiFetch<{ product: AdminProductDetail; changed: boolean }>(`/api/admin/products/${encodeURIComponent(product.id)}`, {
        method: "PATCH",
        body: {
          content: { features: parsed.features.items, benefits: parsed.benefits.items, requirements: parsed.requirements.items },
          relatedIds: related,
        },
      });
      adminToast.success(res.changed ? "Changes saved" : "No changes to save");
      onSaved(res.product);
    } catch (error) {
      setErrors(contentErrors(fieldErrorsOf(error)));
      setFormError(formErrorOf(error));
    } finally {
      setBusy(false);
    }
  }

  const box = (part: Part, label: string) => (
    <Field size="sm" label={label} hint={CONTENT_LINE_HINTS[part]} error={errors[part]} optional={part !== "features"}>
      <Textarea
        size="sm"
        rows={part === "features" ? 6 : 4}
        spellCheck={false}
        className="font-mono text-[12px]"
        value={text[part]}
        onChange={(e) => setText({ ...text, [part]: e.target.value })}
      />
    </Field>
  );

  return (
    <form onSubmit={submit} noValidate className="grid gap-2.5">
      <fieldset disabled={readOnly} className="m-0 grid min-w-0 gap-2.5 border-0 p-0">
        {box("features", "Features")}
        {box("benefits", "Benefits")}
        {box("requirements", "System requirements")}
        <fieldset className="m-0 grid min-w-0 gap-1.5 border-0 p-0">
          <legend className="mb-1.5 p-0 text-[12.5px] font-bold">Related products</legend>
          {others.length === 0 ? <p className="m-0 text-[12.5px] text-ink-2">No other products yet.</p> : null}
          <div className="grid gap-1.5 min-[32.5rem]:grid-cols-2">
            {others.map((p) => {
              const checked = related.includes(p.id);
              return (
                <label key={p.id} className="inline-flex cursor-pointer items-center gap-2 text-[13px] font-semibold">
                  <Checkbox
                    checked={checked}
                    disabled={!checked && related.length >= MAX_RELATED}
                    onCheckedChange={(on) => setRelated(on === true ? [...related, p.id] : related.filter((x) => x !== p.id))}
                  />
                  {p.name}
                </label>
              );
            })}
          </div>
          {errors.relatedIds ? <p className="m-0 text-[13px] font-semibold text-danger">{errors.relatedIds}</p> : null}
        </fieldset>
        <FormAlert>{formError}</FormAlert>
        <DrawerSubmit disabled={busy} aria-busy={busy || undefined}>
          Save content
        </DrawerSubmit>
      </fieldset>
    </form>
  );
}
