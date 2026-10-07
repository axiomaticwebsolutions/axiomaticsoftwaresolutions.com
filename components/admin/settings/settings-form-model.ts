/**
 * Pure helpers of the settings forms (unit-tested): drafts as form strings, the patch of changed fields with typed
 * values, and client-side checks that only catch what the browser can (numbers). Every other rule is the server's
 * (lib/config schemas), whose messages come back as field errors.
 */
import type { SettingsFieldDef, SettingsSectionDef } from "@/lib/admin/settings/model";

export type DraftValue = string | boolean;
export type Draft = Record<string, DraftValue>;

/** Form draft of a section value: switches stay booleans, everything else a string. */
export function toDraft(section: SettingsSectionDef, value: Readonly<Record<string, unknown>>): Draft {
  const draft: Draft = {};
  for (const field of section.fields) {
    const v = value[field.key];
    draft[field.key] = field.kind === "switch" ? v === true : v === null || v === undefined ? "" : String(v);
  }
  return draft;
}

function sameValue(field: SettingsFieldDef, a: DraftValue | undefined, b: DraftValue | undefined): boolean {
  if (field.kind === "switch") return Boolean(a) === Boolean(b);
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (field.kind === "number") return x.trim() === y.trim() || (x.trim() !== "" && y.trim() !== "" && Number(x) === Number(y));
  return x === y;
}

/** Keys whose draft differs from the saved baseline, in form order. */
export function changedKeys(section: SettingsSectionDef, baseline: Draft, draft: Draft): string[] {
  return section.fields.filter((f) => !sameValue(f, baseline[f.key], draft[f.key])).map((f) => f.key);
}

export const NUMBER_ERROR = "Enter a number.";

/** Client-side errors (only numbers that do not parse); the server checks everything else. */
export function draftErrors(section: SettingsSectionDef, draft: Draft, keys: readonly string[]): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of section.fields) {
    if (!keys.includes(field.key) || field.kind !== "number") continue;
    const raw = String(draft[field.key] ?? "").trim();
    if (raw === "" || !Number.isFinite(Number(raw))) errors[field.key] = NUMBER_ERROR;
  }
  return errors;
}

/** PATCH body: the changed keys with typed values (numbers parsed, switches booleans, text as typed). */
export function patchFromDraft(section: SettingsSectionDef, draft: Draft, keys: readonly string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of section.fields) {
    if (!keys.includes(field.key)) continue;
    const v = draft[field.key];
    if (field.kind === "switch") patch[field.key] = v === true;
    else if (field.kind === "number") patch[field.key] = Number(String(v ?? "").trim());
    else patch[field.key] = String(v ?? "");
  }
  return patch;
}

/** First message per field from a 422 response's fieldErrors. */
export function firstFieldErrors(fieldErrors: Readonly<Record<string, readonly string[]>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, messages] of Object.entries(fieldErrors)) {
    const first = messages[0];
    if (first) out[key.split(".")[0] ?? key] = first;
  }
  return out;
}
