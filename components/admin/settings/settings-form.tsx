"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { useAdminOptional } from "@/components/admin/admin-context";
import { adminToast } from "@/components/admin/admin-toaster";
import { Button } from "@/components/ui/button";
import { Field, FieldError, type FieldControlProps } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { sectionNote, SETTINGS_COPY, type SettingsFieldDef, type SettingsSectionDef } from "@/lib/admin/settings/model";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import { READ_ONLY_FOR_ROLE } from "@/lib/rbac";
import { cn } from "@/lib/utils";
import { SettingsCard, SettingsGrid } from "./settings-card";
import {
  changedKeys,
  draftErrors,
  firstFieldErrors,
  patchFromDraft,
  toDraft,
  type Draft,
} from "./settings-form-model";

/** Read-only facts shown inside a section (next invoice number, offline grace...). */
export type SettingsFact = { label: string; value: string; mono?: boolean; help?: string };

export type SettingsFormProps = {
  section: SettingsSectionDef;
  /** The saved section value (from the server). */
  value: Readonly<Record<string, unknown>>;
  facts?: readonly SettingsFact[];
};

type SaveResponse = { value: Record<string, unknown>; changes: { field: string }[] };

/** The control inside a Field: Field clones its id and aria attributes onto this element, which hands them on. */
function FieldControl({
  field,
  value,
  onChange,
  ...control
}: Partial<FieldControlProps> & {
  field: SettingsFieldDef;
  value: string;
  onChange: (value: string) => void;
}) {
  if (field.kind === "select") {
    return (
      <NativeSelect {...control} size="sm" value={value} onChange={(e) => onChange(e.target.value)} className="font-semibold">
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </NativeSelect>
    );
  }
  return (
    <Input
      {...control}
      size="sm"
      mono={field.mono}
      type={field.kind === "number" ? "number" : field.kind === "email" ? "email" : field.kind === "tel" ? "tel" : "text"}
      inputMode={field.inputMode}
      min={field.min}
      max={field.max}
      step={field.step}
      maxLength={field.kind === "number" ? undefined : field.maxLength}
      autoComplete={field.autoComplete ?? "off"}
      spellCheck={false}
      value={value}
      onChange={(e) => onChange(field.upper ? e.target.value.toUpperCase() : e.target.value)}
      className="font-semibold"
    />
  );
}

function SwitchRow({ id, field, checked, onChange, error }: { id: string; field: SettingsFieldDef; checked: boolean; onChange: (v: boolean) => void; error?: string }) {
  const hintId = field.help ? `${id}-hint` : undefined;
  return (
    <div className="col-span-full grid gap-1.5">
      <div className="flex items-start justify-between gap-3 rounded-10 border border-line-subtle bg-bg px-3 py-2.5">
        <div className="grid min-w-0 gap-0.5">
          <label htmlFor={id} className="cursor-pointer text-[12.5px] font-bold">
            {field.label}
          </label>
          {field.help ? (
            <p id={hintId} className="m-0 text-[12px] text-ink-2">
              {field.help}
            </p>
          ) : null}
        </div>
        <Switch id={id} checked={checked} onCheckedChange={onChange} aria-describedby={hintId} aria-invalid={error ? true : undefined} />
      </div>
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}

/**
 * One settings section as a form (prototype `sec()`): fields in an auto-fit grid, read-only facts, the footer note
 * and Save. Only changed fields are sent (PATCH /api/admin/settings/:section); nothing changed -> "No changes to save".
 * Server field errors show under their fields and focus the first one. Read only for roles without settings.manage.
 */
export function SettingsForm({ section, value, facts = [] }: SettingsFormProps) {
  const router = useRouter();
  const admin = useAdminOptional();
  const locked = !!admin && !admin.can("settings.manage");
  const uid = React.useId();
  const [baseline, setBaseline] = React.useState<Draft>(() => toDraft(section, value));
  const [draft, setDraft] = React.useState<Draft>(baseline);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  const fieldId = (key: string) => `${uid}-${key}`;

  const focusFirst = (keys: readonly string[]) => {
    const first = section.fields.find((f) => keys.includes(f.key));
    if (first) window.requestAnimationFrame(() => document.getElementById(fieldId(first.key))?.focus());
  };

  function set(key: string, next: string | boolean) {
    setDraft((d) => ({ ...d, [key]: next }));
    setErrors((e) => (e[key] ? { ...e, [key]: "" } : e));
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || locked) return;
    const keys = changedKeys(section, baseline, draft);
    if (keys.length === 0) {
      adminToast.success(SETTINGS_COPY.noChanges);
      return;
    }
    const local = draftErrors(section, draft, keys);
    if (Object.keys(local).length > 0) {
      setErrors(local);
      focusFirst(Object.keys(local));
      return;
    }
    setBusy(true);
    try {
      const res = await apiFetch<SaveResponse>(`/api/admin/settings/${section.id}`, { method: "PATCH", body: patchFromDraft(section, draft, keys) });
      const saved = toDraft(section, res.value);
      setBaseline(saved);
      setDraft(saved);
      setErrors({});
      adminToast.success(res.changes.length > 0 ? SETTINGS_COPY.saved(section.title) : SETTINGS_COPY.noChanges);
      router.refresh();
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 422) {
        const fieldErrors = firstFieldErrors(error.fieldErrors);
        setErrors(fieldErrors);
        focusFirst(Object.keys(fieldErrors));
      }
      adminToast.error(error);
    } finally {
      setBusy(false);
    }
  }

  const sample = draft.sample === true;
  return (
    <SettingsCard
      as="form"
      id={`settings-${section.id}`}
      icon={section.icon}
      title={section.title}
      description={section.description}
      onSubmit={submit}
      note={locked ? READ_ONLY_FOR_ROLE : sectionNote(section.id, { sample })}
      action={
        <Button type="submit" size="sm" loading={busy} disabled={locked} className="px-3.5 py-[7px] text-[13px]">
          {SETTINGS_COPY.save}
        </Button>
      }
    >
      <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
        <SettingsGrid>
          {section.fields.map((field) =>
            field.kind === "switch" ? (
              <SwitchRow key={field.key} id={fieldId(field.key)} field={field} checked={draft[field.key] === true} onChange={(v) => set(field.key, v)} error={errors[field.key] || undefined} />
            ) : (
              <Field key={field.key} id={fieldId(field.key)} size="sm" label={field.label} hint={field.help} error={errors[field.key] || undefined} className={cn("content-start gap-[5px]", field.wide && "col-span-full")}>
                <FieldControl field={field} value={String(draft[field.key] ?? "")} onChange={(v) => set(field.key, v)} />
              </Field>
            ),
          )}
          {facts.map((fact) => (
            <Field key={fact.label} size="sm" label={fact.label} hint={fact.help} className="content-start gap-[5px]">
              <Input size="sm" mono={fact.mono} readOnly value={fact.value} className="font-semibold" />
            </Field>
          ))}
        </SettingsGrid>
      </fieldset>
    </SettingsCard>
  );
}
