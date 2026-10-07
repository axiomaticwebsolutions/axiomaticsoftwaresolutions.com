"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import * as React from "react";
import { DisabledAction } from "@/components/account/disabled-action";
import { PageHeader } from "@/components/account/page-header";
import { usePortal } from "@/components/account/portal-context";
import { relativeTime } from "@/components/account/portal-nav";
import { AttachButton, AttachmentChips, AttachmentMessages, PostedAttachment } from "@/components/account/tickets/attachments";
import { TICKET_TEXTAREA } from "@/components/account/tickets/form-parts";
import {
  followUpTicketHref,
  openCountDelta,
  readOnlyNotice,
  replyError,
  ticketComposer,
  ticketMetaRows,
  TICKETS_COPY,
} from "@/components/account/tickets/model";
import { useAttachments } from "@/components/account/tickets/use-attachments";
import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { toast } from "@/components/ui/sonner";
import { Textarea } from "@/components/ui/textarea";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { formatDateTimeIST } from "@/lib/dates";
import type { TicketDetail, TicketMessageView } from "@/lib/portal/tickets";
import { cn } from "@/lib/utils";

type Pending = null | "send" | "resolve" | "reopen";

/** Codes after which the page's copy of the ticket is stale (another member or support changed it). */
const STALE_CODES = new Set(["ticket_resolved", "ticket_closed", "ticket_changed", "not_found"]);

function Message({ message, now }: { message: TicketMessageView; now: Date }) {
  const staff = message.author.isStaff;
  const at = new Date(message.createdAt);
  return (
    <li className={cn("rounded-14 border px-4 py-3.5", staff ? "border-lavender-line bg-lavender-soft" : "border-line-alt bg-surface")}>
      <div className="flex items-center gap-2.5 text-[13px] font-bold">
        <span
          aria-hidden="true"
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-pill text-[11.5px] font-extrabold",
            staff ? "bg-primary text-white" : "bg-sage-bg text-sage-fg",
          )}
        >
          {message.author.initials}
        </span>
        <span className="min-w-0 flex-1">{message.author.label}</span>
        <time dateTime={message.createdAt} title={formatDateTimeIST(at)} className="shrink-0 font-semibold text-ink-2">
          {relativeTime(at, now)}
        </time>
      </div>
      <p className="mb-0 mt-2.5 whitespace-pre-wrap text-[14.5px] leading-[1.6] [overflow-wrap:anywhere]">{message.body}</p>
      {message.attachments.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {message.attachments.map((attachment, i) => (
            <PostedAttachment key={attachment.id ?? `${i}:${attachment.name}`} attachment={attachment} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function MetaPanel({ detail, now }: { detail: TicketDetail; now: Date }) {
  const rows = ticketMetaRows(detail.ticket, (at) => relativeTime(at, now));
  return (
    <aside aria-label={TICKETS_COPY.details} className="rounded-14 border border-line-alt bg-surface">
      <dl className="m-0 grid">
        {rows.map((row, i) => (
          <div
            key={row.key}
            className={cn("flex justify-between gap-3 px-4 py-[11px] text-[13.5px]", i < rows.length - 1 && "border-b border-line-subtle")}
          >
            <dt className="font-semibold text-ink-2">{row.label}</dt>
            <dd className="m-0 min-w-0 text-right font-bold [overflow-wrap:anywhere]">
              {row.href ? (
                <Link href={row.href} className="rounded-6 font-mono text-[13px] text-primary-link hover:text-primary-link-hover">
                  {row.value}
                </Link>
              ) : (
                row.value
              )}
            </dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}

/**
 * Ticket detail (prototype "Ticket detail"): title = subject, "{id} · {status}", the conversation (support messages
 * lavender, customer white, attachments as download chips), and under it the reply form with attachments, "Mark
 * resolved" and "Send reply"; a resolved ticket shows "This ticket is resolved." with Reopen instead. The details
 * panel sits on the right from 1100px. Roles without tickets.create read the ticket only.
 */
export function TicketDetailView({ initial, nowIso }: { initial: TicketDetail; nowIso: string }) {
  const router = useRouter();
  const { can, role, counts, updateCounts } = usePortal();
  const canCreate = can("tickets.create");
  const attachments = useAttachments();
  const [detail, setDetail] = React.useState(initial);
  const [seen, setSeen] = React.useState(initial);
  if (initial !== seen) {
    // A server re-render (router.refresh) brings the latest ticket.
    setSeen(initial);
    setDetail(initial);
  }
  const [body, setBody] = React.useState("");
  const [bodyError, setBodyError] = React.useState<string | null>(null);
  const [attachError, setAttachError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<Pending>(null);
  const replyRef = React.useRef<HTMLTextAreaElement>(null);
  const bannerRef = React.useRef<HTMLDivElement>(null);
  const now = React.useMemo(() => new Date(nowIso), [nowIso]);
  const { ticket } = detail;
  const composer = ticketComposer(ticket.status, canCreate);
  const path = `/api/account/tickets/${encodeURIComponent(ticket.id)}`;

  function applied(next: TicketDetail) {
    const delta = openCountDelta(detail.ticket.status, next.ticket.status);
    if (delta !== 0) updateCounts({ tickets: Math.max(0, counts.tickets + delta) });
    setDetail(next);
    router.refresh();
  }

  function failed(error: unknown) {
    const message = error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE;
    toast.error(message);
    if (error instanceof ApiClientError && STALE_CODES.has(error.code)) router.refresh();
  }

  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const problem = replyError(body);
    setBodyError(problem);
    setAttachError(attachments.blocker);
    if (problem || attachments.blocker) {
      (problem ? replyRef.current : null)?.focus();
      return;
    }
    setPending("send");
    try {
      const next = await apiFetch<TicketDetail>(`${path}/messages`, {
        method: "POST",
        body: { body, attachmentIds: attachments.readyIds },
      });
      setBody("");
      attachments.reset();
      applied(next);
      toast.success(TICKETS_COPY.replySent);
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 422) {
        const fields = error.fieldErrors;
        const bodyMessage = fields.body?.[0];
        const attachMessage = Object.entries(fields).find(([key]) => key.startsWith("attachmentIds"))?.[1][0];
        if (bodyMessage || attachMessage) {
          setBodyError(bodyMessage ?? null);
          setAttachError(attachMessage ?? null);
          return;
        }
      }
      failed(error);
    } finally {
      setPending(null);
    }
  }

  async function changeStatus(action: "resolve" | "reopen") {
    if (pending) return;
    setPending(action);
    try {
      const next = await apiFetch<TicketDetail>(`${path}/status`, { method: "POST", body: { action } });
      applied(next);
      if (action === "resolve") {
        toast.success(TICKETS_COPY.resolvedToast);
        window.requestAnimationFrame(() => bannerRef.current?.focus());
      } else {
        window.requestAnimationFrame(() => replyRef.current?.focus());
      }
    } catch (error) {
      failed(error);
    } finally {
      setPending(null);
    }
  }

  const reopenButton = (
    <button
      type="button"
      onClick={() => void changeStatus("reopen")}
      aria-busy={pending === "reopen" || undefined}
      className="cursor-pointer rounded-6 border-0 bg-transparent p-0 font-extrabold text-sage-fg underline underline-offset-2 aria-busy:cursor-progress"
    >
      {TICKETS_COPY.reopen}
    </button>
  );

  return (
    <>
      <PageHeader title={ticket.subject} description={`${ticket.id} \u00B7 ${ticket.statusLabel}`} />
      <div className="grid items-start gap-4 motion-safe:animate-enter-up min-[68.75rem]:grid-cols-[minmax(0,1fr)_300px]">
        <div className="grid min-w-0 gap-3">
          <section aria-label={TICKETS_COPY.conversation}>
            <ol className="m-0 grid list-none gap-3 p-0">
              {detail.messages.map((message) => (
                <Message key={message.id} message={message} now={now} />
              ))}
            </ol>
          </section>

          {composer === "resolved" ? (
            <div
              ref={bannerRef}
              tabIndex={-1}
              className="flex flex-wrap items-center gap-2.5 rounded-12 bg-sage-bg px-3.5 py-3 text-[14px] font-bold text-sage-fg"
            >
              {TICKETS_COPY.resolvedBanner}
              {ticket.canReopen ? (
                reopenButton
              ) : (
                <DisabledAction perm="tickets.create" asChild>
                  {reopenButton}
                </DisabledAction>
              )}
            </div>
          ) : null}

          {composer === "closed" ? (
            <div
              ref={bannerRef}
              tabIndex={-1}
              className="flex flex-wrap items-center gap-2.5 rounded-12 bg-slate-bg px-3.5 py-3 text-[14px] font-bold text-slate-fg"
            >
              {TICKETS_COPY.closedBanner}
              {canCreate ? (
                <Link href={followUpTicketHref(ticket)} className="rounded-6 font-extrabold text-primary-link underline underline-offset-2 hover:text-primary-link-hover">
                  {TICKETS_COPY.startNew}
                </Link>
              ) : null}
            </div>
          ) : null}

          {composer === "readonly" ? (
            <p className="m-0 flex items-start gap-2 rounded-12 border border-line-alt bg-surface px-3.5 py-3 text-[13.5px] font-semibold text-ink-2">
              <Icon name="lock" size={17} className="mt-px text-ink-3" />
              {readOnlyNotice(role)}
            </p>
          ) : null}

          {composer === "reply" ? (
            <form noValidate onSubmit={(event) => void send(event)} className="rounded-14 border border-line-alt bg-surface p-3.5">
              <label htmlFor="ticket-reply" className="mb-1.5 block text-[13px] font-bold">
                {TICKETS_COPY.reply}
              </label>
              <Textarea
                ref={replyRef}
                id="ticket-reply"
                rows={4}
                value={body}
                onChange={(event) => {
                  setBody(event.target.value);
                  if (bodyError) setBodyError(null);
                }}
                placeholder={TICKETS_COPY.replyPlaceholder}
                aria-invalid={bodyError ? true : undefined}
                aria-describedby={bodyError ? "ticket-reply-error" : undefined}
                className={TICKET_TEXTAREA}
              />
              {bodyError ? (
                <FieldError id="ticket-reply-error" className="mt-1.5">
                  {bodyError}
                </FieldError>
              ) : null}
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <AttachButton label={TICKETS_COPY.attach} controller={attachments} describedBy="ticket-reply-attach-messages ticket-reply-note" invalid={!!attachError} />
                <AttachmentChips controller={attachments} />
                <span className="flex-1" />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  loading={pending === "resolve"}
                  onClick={() => void changeStatus("resolve")}
                  className="rounded-9 px-3.5"
                >
                  {TICKETS_COPY.markResolved}
                </Button>
                <Button type="submit" size="sm" loading={pending === "send"} loadingText={TICKETS_COPY.sending} className="rounded-9 px-4">
                  {TICKETS_COPY.sendReply}
                </Button>
              </div>
              <AttachmentMessages controller={attachments} id="ticket-reply-attach-messages" extra={attachError} className="mt-2" />
              <p id="ticket-reply-note" className="mb-0 mt-2 text-[12px] text-ink-2">
                {TICKETS_COPY.attachNote}
              </p>
            </form>
          ) : null}
        </div>
        <MetaPanel detail={detail} now={now} />
      </div>
    </>
  );
}
