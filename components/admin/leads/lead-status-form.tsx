"use client";

import { DrawerSubmit } from "@/components/admin/drawer";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  LEAD_COPY,
  LEAD_NOTE_MAX,
  LEAD_STATUS_HINTS,
  LEAD_STATUS_LABELS,
  leadStatusesFor,
  type LeadDto,
  type LeadStatusValue,
} from "@/lib/admin/leads/model";

export type LeadStatusDraft = { status: LeadStatusValue; note: string };

type Props = {
  lead: LeadDto;
  draft: LeadStatusDraft;
  onChange: (draft: LeadStatusDraft) => void;
  errors: Record<string, string>;
  formError: string | null;
  busy: boolean;
  onSubmit: () => void;
};

/** "Update status": the workflow status (Scheduled only for demo requests) and a staff note for the history. */
export function LeadStatusForm({ lead, draft, onChange, errors, formError, busy, onSubmit }: Props) {
  const idPrefix = `lead-${lead.id}`;
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
      <Field label="Status" size="sm" error={errors.status} hint={LEAD_STATUS_HINTS[draft.status]} id={`${idPrefix}-status`}>
        <NativeSelect size="sm" value={draft.status} onChange={(e) => onChange({ ...draft, status: e.target.value as LeadStatusValue })}>
          {leadStatusesFor(lead.kind).map((s) => (
            <option key={s} value={s}>
              {LEAD_STATUS_LABELS[s]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field label={LEAD_COPY.noteLabel} size="sm" optional error={errors.note} hint={LEAD_COPY.noteHint} id={`${idPrefix}-note`}>
        <Textarea size="sm" rows={3} maxLength={LEAD_NOTE_MAX} value={draft.note} onChange={(e) => onChange({ ...draft, note: e.target.value })} />
      </Field>
      <DrawerSubmit loading={busy}>Save</DrawerSubmit>
    </form>
  );
}
