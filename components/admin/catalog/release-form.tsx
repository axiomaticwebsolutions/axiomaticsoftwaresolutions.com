"use client";

import * as React from "react";
import { adminToast } from "@/components/admin/admin-toaster";
import { DrawerSubmit } from "@/components/admin/drawer";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { releaseChannelLabel } from "@/lib/admin/catalog/model";
import { RELEASE_CHANNELS } from "@/lib/admin/catalog/schemas";
import type { AdminReleaseDetail } from "@/lib/admin/catalog/types";
import { apiFetch } from "@/lib/client/api";
import { fieldErrorsOf, FormAlert, formErrorOf, FormGrid } from "./shared";

/** Notes as typed: one per line, blank lines dropped. */
export function notesFromText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** "notes.3" -> "Line 4: ..." */
export function notesError(errors: Record<string, string>): string | undefined {
  for (const [key, message] of Object.entries(errors)) {
    const m = /^notes(?:\.(\d+))?$/.exec(key);
    if (m) return m[1] !== undefined ? `Line ${Number(m[1]) + 1}: ${message}` : message;
  }
  return undefined;
}

type FieldsProps = {
  version: string;
  channel: string;
  notes: string;
  onChange: (patch: Partial<{ version: string; channel: string; notes: string }>) => void;
  errors: Record<string, string>;
  idPrefix: string;
  /** Why the version cannot change (published, or installers uploaded). */
  versionLock?: string;
  /** Published releases keep their channel. */
  channelLocked?: boolean;
};

export function ReleaseFields({ version, channel, notes, onChange, errors, idPrefix, versionLock, channelLocked = false }: FieldsProps) {
  return (
    <>
      <FormGrid>
        <Field size="sm" label="Version" hint={versionLock ?? "Like 4.2.1, or 5.0.0-beta.1."} error={errors.version} id={`${idPrefix}-version`}>
          <Input size="sm" mono value={version} maxLength={64} readOnly={!!versionLock} autoComplete="off" onChange={(e) => onChange({ version: e.target.value.trim() })} />
        </Field>
        <Field size="sm" label="Channel" hint="Customers only see the Stable channel." error={errors.channel} id={`${idPrefix}-channel`}>
          <NativeSelect size="sm" value={channel} disabled={channelLocked} onChange={(e) => onChange({ channel: e.target.value })}>
            {RELEASE_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {releaseChannelLabel(c)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </FormGrid>
      <Field size="sm" label="Release notes" hint="One note per line. The first line is the summary in lists." error={notesError(errors)} id={`${idPrefix}-notes`}>
        <Textarea size="sm" rows={6} className="font-mono text-[12.5px]" value={notes} onChange={(e) => onChange({ notes: e.target.value })} />
      </Field>
    </>
  );
}

/** The drawer's "Release details" form (drafts: version, channel and notes; published: notes). */
export function ReleaseEditForm({ release, readOnly, onSaved }: { release: AdminReleaseDetail; readOnly: boolean; onSaved: (r: AdminReleaseDetail) => void }) {
  const uid = React.useId();
  const [value, setValue] = React.useState({ version: release.version, channel: release.channel, notes: release.notes.join("\n") });
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const draft = release.rawStatus === "DRAFT";

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || readOnly) return;
    setBusy(true);
    setFormError(null);
    const body: Record<string, unknown> = { notes: notesFromText(value.notes) };
    if (draft) {
      body.channel = value.channel;
      if (value.version !== release.version) body.version = value.version;
    }
    try {
      const res = await apiFetch<{ release: AdminReleaseDetail; changed: boolean }>(`/api/admin/releases/${encodeURIComponent(release.id)}`, { method: "PATCH", body });
      setErrors({});
      adminToast.success(res.changed ? "Changes saved" : "No changes to save");
      onSaved(res.release);
    } catch (error) {
      setErrors(fieldErrorsOf(error));
      setFormError(formErrorOf(error));
    } finally {
      setBusy(false);
    }
  }

  const versionLock = !draft
    ? "Published releases keep their version."
    : release.fileCount > 0
      ? "Remove the installers to change the version."
      : undefined;
  return (
    <form onSubmit={submit} noValidate className="grid gap-2.5">
      <ReleaseFields
        version={value.version}
        channel={value.channel}
        notes={value.notes}
        onChange={(patch) => setValue({ ...value, ...patch })}
        errors={errors}
        idPrefix={uid}
        versionLock={versionLock}
        channelLocked={!draft}
      />
      <FormAlert>{formError}</FormAlert>
      <DrawerSubmit disabled={busy} aria-busy={busy || undefined} />
    </form>
  );
}
