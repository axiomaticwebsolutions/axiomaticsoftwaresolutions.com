"use client";

import { DrawerSubmit } from "@/components/admin/drawer";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import type { FaqPageOption } from "@/lib/admin/content/model";
import { FAQ_HREF_MAX } from "@/lib/admin/content/schemas";

export type FaqDraft = { page: string; question: string; answer: string; href: string };

type Props = {
  draft: FaqDraft;
  onChange: (draft: FaqDraft) => void;
  pages: readonly FaqPageOption[];
  errors: Record<string, string>;
  formError: string | null;
  busy: boolean;
  onSubmit: () => void;
  submitLabel: string;
  idPrefix: string;
};

/** FAQ editor (prototype "Edit FAQ": Question, Answer) plus the page and the optional guide link. */
export function FaqForm({ draft, onChange, pages, errors, formError, busy, onSubmit, submitLabel, idPrefix }: Props) {
  const set = <K extends keyof FaqDraft>(key: K, value: FaqDraft[K]) => onChange({ ...draft, [key]: value });
  const fixed = pages.filter((p) => p.kind === "page");
  const products = pages.filter((p) => p.kind === "product");
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
      <Field label="Question" size="sm" error={errors.question} id={`${idPrefix}-question`}>
        <Input size="sm" maxLength={300} value={draft.question} onChange={(e) => set("question", e.target.value)} />
      </Field>
      <Field label="Answer" size="sm" error={errors.answer} id={`${idPrefix}-answer`}>
        <Textarea size="sm" rows={6} maxLength={3000} className="font-mono text-[13px]" value={draft.answer} onChange={(e) => set("answer", e.target.value)} />
      </Field>
      <div className="grid gap-2.5 min-[26.25rem]:grid-cols-2">
        <Field label="Page" size="sm" error={errors.page} hint="Moving it puts it last on the new page." id={`${idPrefix}-page`}>
          <NativeSelect size="sm" value={draft.page} onChange={(e) => set("page", e.target.value)}>
            <optgroup label="Pages">
              {fixed.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </optgroup>
            {products.length > 0 ? (
              <optgroup label="Product pages">
                {products.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </NativeSelect>
        </Field>
        <Field label="Guide link" size="sm" optional error={errors.href} hint="A page on this site, e.g. /docs/activation." id={`${idPrefix}-href`}>
          <Input size="sm" mono maxLength={FAQ_HREF_MAX} placeholder="/docs/…" value={draft.href} onChange={(e) => set("href", e.target.value)} />
        </Field>
      </div>
      <DrawerSubmit loading={busy}>{submitLabel}</DrawerSubmit>
    </form>
  );
}
