"use client";

import Link from "next/link";
import * as React from "react";
import { AdminAction } from "@/components/admin/admin-action";
import { useAdmin } from "@/components/admin/admin-context";
import { errorMessage, adminToast } from "@/components/admin/admin-toaster";
import { AdminDrawer, type AdminField } from "@/components/admin/drawer";
import { StatusBadge } from "@/components/admin/status-badge";
import { apiFetch } from "@/lib/client/api";
import {
  firstResponseLabel,
  formatTicketTime,
  isActiveTicketStatus,
  PRIORITY_LABELS,
  relativeTicketTime,
  type TicketAssigneeOption,
} from "@/lib/admin/tickets/model";
import type { AdminTicketDetail, StaffMessageResult } from "@/lib/admin/tickets/service";
import { TicketConversation } from "./conversation";
import { REPLY_COPY, ReplyForm } from "./reply-form";
import { customerHref, licenseHref, ticketApiPath, type TicketMetaPatch } from "./console-model";
import { TicketMetaForm } from "./ticket-meta-form";

const LINK = "rounded-6 font-bold text-primary-link underline underline-offset-2 hover:text-primary-link-hover";
const LOAD_FAILED = "We couldn\u2019t load this ticket. Try again.";

type Loaded = { id: string; detail: AdminTicketDetail; at: number };
type PatchAction = "assign" | "resolve" | "reopen" | "meta";

export type TicketDrawerProps = {
  /** The open ticket (`?id=`), or null. */
  ticketId: string | null;
  onOpenChange: (open: boolean) => void;
  assignees: readonly TicketAssigneeOption[];
  /** Something changed on the server: refresh the list, stats and badge. */
  onChanged: () => void;
};

/** The facts grid (prototype: Priority, Assignee, Opened, Last update, Customer, First-reply target). */
function ticketFields(t: AdminTicketDetail["ticket"], now: Date): AdminField[] {
  return [
    { label: "Priority", value: PRIORITY_LABELS[t.priority] },
    { label: "Assignee", value: t.assignee?.name ?? "Unassigned" },
    { label: "Opened", value: formatTicketTime(t.createdAt) },
    { label: "Last update", value: relativeTicketTime(t.updatedAt, now) },
    {
      label: "Customer",
      value: t.customer ? (
        <span className="grid">
          <span className="break-words">{t.customer.name}</span>
          <Link href={customerHref(t.customer.email)} className={`${LINK} break-all text-[12.5px]`}>
            {t.customer.email}
          </Link>
        </span>
      ) : null,
    },
    { label: "First response", value: firstResponseLabel(t) },
    { label: "Business", value: t.account.name },
    {
      label: "License",
      mono: true,
      value: t.licenseId ? (
        <Link href={licenseHref(t.licenseId)} className={LINK}>
          {t.licenseId}
        </Link>
      ) : null,
    },
  ];
}

/**
 * Ticket drawer (prototype `detail` of #tickets): "TICKET · {id}", subject, status badge and "{business} · {product}",
 * the facts grid, the reply box (public reply or internal note, with attachments), the conversation with internal
 * notes marked, the status / priority / assignee form, and Assign to me + Resolve / Reopen in the footer. Loads
 * GET /api/admin/tickets/:id when it opens; every change answers with the updated ticket.
 */
export function TicketDrawer({ ticketId, onOpenChange, assignees, onChanged }: TicketDrawerProps) {
  const admin = useAdmin();
  const [loaded, setLoaded] = React.useState<Loaded | null>(null);
  const [failed, setFailed] = React.useState<{ id: string; message: string } | null>(null);
  const [busy, setBusy] = React.useState<PatchAction | null>(null);
  const [mode, setMode] = React.useState<{ id: string | null; internal: boolean }>({ id: null, internal: false });

  React.useEffect(() => {
    if (!ticketId) return;
    const controller = new AbortController();
    apiFetch<AdminTicketDetail>(ticketApiPath(ticketId), { signal: controller.signal })
      .then((detail) => setLoaded({ id: ticketId, detail, at: Date.now() }))
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setFailed({ id: ticketId, message: errorMessage(e, LOAD_FAILED) });
      });
    return () => controller.abort();
  }, [ticketId]);

  // While closing, keep showing the last ticket so the sheet slides out with its content.
  const detail = loaded && (ticketId === null || loaded.id === ticketId) ? loaded.detail : null;
  const error = ticketId && failed?.id === ticketId && !detail ? failed.message : null;
  const loadedAt = loaded?.at ?? 0;
  const now = React.useMemo(() => new Date(loadedAt || Date.now()), [loadedAt]);
  const internal = mode.id === ticketId && mode.internal;

  function apply(next: AdminTicketDetail) {
    setLoaded({ id: next.ticket.id, detail: next, at: Date.now() });
    onChanged();
  }

  async function patch(action: PatchAction, body: TicketMetaPatch, success: string) {
    if (!detail || busy) return;
    setBusy(action);
    try {
      const result = await apiFetch<{ detail: AdminTicketDetail }>(ticketApiPath(detail.ticket.id), { method: "PATCH", body });
      apply(result.detail);
      adminToast.success(success);
    } catch (e) {
      adminToast.error(e);
    } finally {
      setBusy(null);
    }
  }

  const t = detail?.ticket;
  const mine = !!t?.assignee && t.assignee.id === admin.staff.id;
  const subtitle = t ? [t.account.name || t.customer?.email, t.product?.shortName || t.product?.name].filter(Boolean).join(" \u00B7 ") : undefined;

  return (
    <AdminDrawer
      open={ticketId !== null}
      onOpenChange={onOpenChange}
      kind={`Ticket \u00B7 ${t?.id ?? ticketId ?? ""}`}
      title={t?.subject ?? (error ? "Ticket unavailable" : "Loading ticket")}
      subtitle={subtitle}
      status={t ? <StatusBadge kind="ticket" status={t.status} /> : undefined}
      loading={!detail && !error}
      error={error}
      fields={t ? ticketFields(t, now) : undefined}
      edit={
        t
          ? {
              title: internal ? REPLY_COPY.noteTitle : REPLY_COPY.replyTitle,
              readOnly: !admin.can("tickets.manage"),
              form: (
                <ReplyForm
                  key={t.id}
                  ticketId={t.id}
                  internal={internal}
                  onInternalChange={(value) => setMode({ id: t.id, internal: value })}
                  onSent={(result: StaffMessageResult) => apply(result.detail)}
                />
              ),
            }
          : undefined
      }
      sections={
        detail && t
          ? [
              {
                id: "conversation",
                title: `Conversation (${detail.messages.length})`,
                empty: "No messages yet.",
                content: detail.messages.length > 0 ? <TicketConversation ticketId={t.id} messages={detail.messages} now={now} /> : null,
              },
              {
                id: "manage",
                title: "Status & assignment",
                content: (
                  <TicketMetaForm
                    current={{ status: t.status, priority: t.priority, assigneeId: t.assignee?.id ?? null }}
                    currentAssigneeName={t.assignee?.name ?? null}
                    assignees={assignees}
                    busy={busy === "meta"}
                    onSave={(body) => void patch("meta", body, "Ticket updated")}
                  />
                ),
              },
            ]
          : undefined
      }
      footer={
        t ? (
          <>
            <AdminAction
              size="sm"
              icon="person_add"
              perm="tickets.manage"
              busy={busy === "assign"}
              disabledReason={mine ? "This ticket is already assigned to you." : undefined}
              onClick={() => void patch("assign", { assigneeId: admin.staff.id }, "Assigned to you")}
            >
              {mine ? "Assigned to you" : "Assign to me"}
            </AdminAction>
            {isActiveTicketStatus(t.status) ? (
              <AdminAction
                size="sm"
                variant="primary"
                icon="task_alt"
                perm="tickets.manage"
                busy={busy === "resolve"}
                onClick={() => void patch("resolve", { status: "resolved" }, "Ticket resolved")}
              >
                Resolve
              </AdminAction>
            ) : (
              <AdminAction
                size="sm"
                icon="undo"
                perm="tickets.manage"
                busy={busy === "reopen"}
                onClick={() => void patch("reopen", { status: "open" }, "Reopened")}
              >
                Reopen
              </AdminAction>
            )}
          </>
        ) : undefined
      }
    />
  );
}
