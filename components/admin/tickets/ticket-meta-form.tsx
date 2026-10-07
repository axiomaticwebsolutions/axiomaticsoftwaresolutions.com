"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import {
  ADMIN_TICKET_PRIORITIES,
  ADMIN_TICKET_STATUSES,
  PRIORITY_LABELS,
  STATUS_LABELS,
  type AdminTicketPriority,
  type AdminTicketStatus,
  type TicketAssigneeOption,
} from "@/lib/admin/tickets/model";
import { ticketMetaPatch, UNASSIGNED_VALUE, type TicketMetaPatch, type TicketMetaValues } from "./console-model";

export type TicketMetaFormProps = {
  current: TicketMetaValues;
  /** Name of the current assignee, for one who no longer handles tickets (kept as an option). */
  currentAssigneeName: string | null;
  assignees: readonly TicketAssigneeOption[];
  busy: boolean;
  onSave: (patch: TicketMetaPatch) => void;
};

/**
 * Status, priority and assignee of the open ticket, saved together with "Update ticket" (selects never act on their
 * own, WCAG 3.2.2). Every change is audited by the API.
 */
export function TicketMetaForm({ current, currentAssigneeName, assignees, busy, onSave }: TicketMetaFormProps) {
  const [draft, setDraft] = React.useState<TicketMetaValues>(current);
  const [base, setBase] = React.useState<TicketMetaValues>(current);
  // A refreshed ticket (saved here, a reply, Resolve) resets the draft to what the server holds.
  if (base.status !== current.status || base.priority !== current.priority || base.assigneeId !== current.assigneeId) {
    setBase(current);
    setDraft(current);
  }
  const patch = ticketMetaPatch(current, draft);
  const listed = current.assigneeId === null || assignees.some((a) => a.id === current.assigneeId);

  return (
    <form
      className="grid gap-2.5 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (patch && !busy) onSave(patch);
      }}
    >
      <div className="grid gap-2.5 min-[30rem]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1.3fr)]">
        <Field size="sm" label="Status">
          <NativeSelect
            size="sm"
            value={draft.status}
            onChange={(event) => setDraft((d) => ({ ...d, status: event.target.value as AdminTicketStatus }))}
          >
            {ADMIN_TICKET_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field size="sm" label="Priority">
          <NativeSelect
            size="sm"
            value={draft.priority}
            onChange={(event) => setDraft((d) => ({ ...d, priority: event.target.value as AdminTicketPriority }))}
          >
            {ADMIN_TICKET_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {PRIORITY_LABELS[priority]}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field size="sm" label="Assignee">
          <NativeSelect
            size="sm"
            value={draft.assigneeId ?? UNASSIGNED_VALUE}
            onChange={(event) => {
              const value = event.target.value;
              setDraft((d) => ({ ...d, assigneeId: value === UNASSIGNED_VALUE ? null : value }));
            }}
          >
            <option value={UNASSIGNED_VALUE}>Unassigned</option>
            {!listed && current.assigneeId ? (
              <option value={current.assigneeId} disabled>
                {currentAssigneeName ?? "Former staff member"}
              </option>
            ) : null}
            {assignees.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div>
        <AdminAction
          type="submit"
          size="sm"
          perm="tickets.manage"
          busy={busy}
          disabledReason={patch ? undefined : "Change the status, priority or assignee first."}
        >
          Update ticket
        </AdminAction>
      </div>
    </form>
  );
}
