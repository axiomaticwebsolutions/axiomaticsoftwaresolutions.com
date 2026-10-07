"use client";

import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useCan } from "@/components/admin/admin-context";
import { formErrorsFrom, NO_ERRORS, type FormErrors } from "@/components/admin/coupons/form-errors";
import { AdminDrawer, type AdminField } from "@/components/admin/drawer";
import { SectionBody, SectionRow, SectionRows } from "@/components/admin/section";
import { StatusBadge } from "@/components/admin/status-badge";
import { toast } from "@/components/ui/sonner";
import { LEAD_COPY, LEAD_STATUS_LABELS, leadSubtitle, type LeadDetail, type LeadDto, type LeadHistoryEntry } from "@/lib/admin/leads/model";
import { relativeAgo } from "@/lib/admin/templates/relative";
import { apiFetch } from "@/lib/client/api";
import { formatDateTimeIST } from "@/lib/dates";
import { LeadStatusForm, type LeadStatusDraft } from "./lead-status-form";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  id: string | null;
  /** The row from the current page, shown while the details load. */
  row: LeadDto | null;
  now: string;
  onChanged: () => void;
};

type DetailState = { id: string | null; detail: LeadDetail | null; failed: boolean };

function useLeadDetail(id: string | null): [DetailState, (detail: LeadDetail) => void] {
  const [state, setState] = React.useState<DetailState>({ id: null, detail: null, failed: false });
  React.useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    apiFetch<LeadDetail>(`/api/admin/leads/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((detail) => setState({ id, detail, failed: false }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ id, detail: null, failed: true });
      });
    return () => controller.abort();
  }, [id]);
  const current = state.id === id ? state : { id, detail: null, failed: false };
  return [current, (detail) => setState({ id, detail, failed: false })];
}

function leadFields(l: LeadDto): AdminField[] {
  const fields: AdminField[] = [
    { label: "Email", value: <a className="break-all text-primary-link underline-offset-2 hover:underline" href={`mailto:${l.email}`}>{l.email}</a> },
    { label: "Phone", value: l.phone ? <a className="text-primary-link underline-offset-2 hover:underline" href={`tel:${l.phone.replace(/\s+/g, "")}`}>{l.phone}</a> : null },
    { label: "Business", value: l.businessName },
  ];
  if (l.kind === "DEMO") {
    fields.push(
      { label: "Product", value: l.productName },
      { label: "Billing counters", value: l.countersLabel },
      { label: "Preferred time (IST)", value: l.preferredLabel },
    );
  } else {
    fields.push({ label: "Topic", value: l.topicLabel });
  }
  fields.push(
    { label: "Marketing emails", value: l.marketingOptIn ? "Opted in" : "Not opted in" },
    { label: "Received", value: formatDateTimeIST(new Date(l.createdAt)) },
  );
  if (l.source) fields.push({ label: "Source", value: l.source, mono: true, wide: true });
  return fields;
}

function History({ entries, lead, now }: { entries: readonly LeadHistoryEntry[]; lead: LeadDto; now: string }) {
  return (
    <SectionRows aria-label={`History of ${lead.id}`}>
      {entries.map((h) => (
        <SectionRow
          key={h.id}
          title={h.detail ? `${h.action} \u00b7 ${h.detail}` : h.action}
          detail={
            <>
              {h.note ? <span className="block whitespace-pre-wrap font-semibold text-ink [overflow-wrap:anywhere]">{h.note}</span> : null}
              <span className="block">
                {h.actorName} · <time dateTime={h.at} title={formatDateTimeIST(new Date(h.at))}>{relativeAgo(h.at, now)}</time>
              </span>
            </>
          }
        />
      ))}
      <SectionRow title={`Received from the ${lead.kind === "DEMO" ? "demo" : "contact"} form`} detail={formatDateTimeIST(new Date(lead.createdAt))} />
    </SectionRows>
  );
}

/**
 * Lead drawer (new; built like the prototype drawers): contact facts, the visitor's message, "Update status" (status +
 * note, saved to the history), the history itself, and Email / Call shortcuts.
 */
export function LeadDrawer({ open, onOpenChange, id, row, now, onChanged }: Props) {
  const canUpdate = useCan("leads.view");
  const [{ detail, failed }, setDetail] = useLeadDetail(open ? id : null);
  const lead = detail?.lead ?? row;
  const [draft, setDraft] = React.useState<LeadStatusDraft>({ status: lead?.status ?? "new", note: "" });
  const [errors, setErrors] = React.useState<FormErrors>(NO_ERRORS);
  const [busy, setBusy] = React.useState(false);
  const stored = lead ? `${lead.id}:${lead.status}` : "none";
  const [formFor, setFormFor] = React.useState(stored);
  if (formFor !== stored) {
    setFormFor(stored);
    setDraft({ status: lead?.status ?? "new", note: "" });
    setErrors(NO_ERRORS);
  }

  async function save() {
    if (!lead) return;
    const note = draft.note.trim();
    if (draft.status === lead.status && note === "") {
      setErrors(NO_ERRORS);
      toast.success(LEAD_COPY.noChanges);
      return;
    }
    setBusy(true);
    try {
      const body = { ...(draft.status !== lead.status ? { status: draft.status } : {}), ...(note ? { note } : {}) };
      const res = await apiFetch<LeadDetail & { changed: boolean }>(`/api/admin/leads/${encodeURIComponent(lead.id)}`, { method: "PATCH", body });
      setDetail({ lead: res.lead, history: res.history });
      setDraft({ status: res.lead.status, note: "" });
      setErrors(NO_ERRORS);
      toast.success(draft.status !== lead.status ? LEAD_COPY.saved : LEAD_COPY.noteSaved);
      onChanged();
    } catch (error) {
      setErrors(formErrorsFrom(error));
    } finally {
      setBusy(false);
    }
  }

  const subject = lead ? `Your ${lead.kind === "DEMO" ? "demo request" : "message"} ${lead.id}` : "";
  return (
    <AdminDrawer
      open={open}
      onOpenChange={onOpenChange}
      kind={lead?.kindLabel ?? "Request"}
      title={lead?.name ?? id ?? "Request"}
      status={lead ? <StatusBadge kind="lead" status={lead.status} label={LEAD_STATUS_LABELS[lead.status]} /> : undefined}
      subtitle={lead ? leadSubtitle(lead) : undefined}
      loading={open && !lead && !failed}
      error={open && !lead && failed ? "This request doesn\u2019t exist." : undefined}
      fields={lead ? leadFields(lead) : undefined}
      edit={
        lead
          ? {
              title: "Update status",
              readOnly: !canUpdate,
              form: (
                <LeadStatusForm lead={lead} draft={draft} onChange={setDraft} errors={errors.fields} formError={errors.form} busy={busy} onSubmit={save} />
              ),
            }
          : undefined
      }
      sections={
        lead
          ? [
              ...(lead.message
                ? [{ id: "message", title: "Message", content: <SectionBody><p className="m-0 min-w-0 whitespace-pre-wrap text-[13.5px] leading-[1.6] [overflow-wrap:anywhere]">{lead.message}</p></SectionBody> }]
                : []),
              {
                id: "history",
                title: "History",
                content: detail ? <History entries={detail.history} lead={lead} now={now} /> : null,
                empty: failed ? "Couldn\u2019t load the history. Reopen the request to try again." : "Loading\u2026",
              },
            ]
          : undefined
      }
      footer={
        lead ? (
          <>
            <AdminAction size="sm" icon="mail" href={`mailto:${lead.email}?subject=${encodeURIComponent(subject)}`} external>
              Email
            </AdminAction>
            {lead.phone ? (
              <AdminAction size="sm" icon="call" href={`tel:${lead.phone.replace(/\s+/g, "")}`} external>
                Call
              </AdminAction>
            ) : null}
          </>
        ) : undefined
      }
    />
  );
}
