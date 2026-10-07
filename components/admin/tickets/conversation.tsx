"use client";

import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { adminToast } from "@/components/admin/admin-toaster";
import { Spinner } from "@/components/ui/spinner";
import { apiFetch } from "@/lib/client/api";
import { formatTicketDateTime, relativeTicketTime } from "@/lib/admin/tickets/model";
import type { AdminTicketMessage } from "@/lib/admin/tickets/service";
import type { AttachmentView } from "@/lib/portal/uploads";
import { cn } from "@/lib/utils";
import { messageAuthorLabel, staffAttachmentPath } from "./console-model";

const CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-9 border border-line-alt bg-surface px-2.5 py-[5px] text-[12.5px] font-bold text-ink";

/** An attachment of a sent message: a link that fetches a 10-minute download link (sample files are plain chips). */
function StaffAttachment({ ticketId, attachment }: { ticketId: string; attachment: AttachmentView }) {
  const [busy, setBusy] = React.useState(false);
  const label = (
    <>
      <Icon name="attach_file" size={16} />
      <span className="min-w-0 truncate">{attachment.name}</span>
      <span aria-hidden="true">{"\u00B7"}</span>
      <span className="shrink-0 whitespace-nowrap">
        <span className="sr-only">, </span>
        {attachment.sizeLabel}
      </span>
    </>
  );
  if (!attachment.id) return <span className={CHIP}>{label}</span>;
  const uploadId = attachment.id;

  async function download(event: React.MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const link = await apiFetch<{ url: string }>(staffAttachmentPath(ticketId, uploadId));
      window.location.assign(link.url);
    } catch (error) {
      adminToast.error(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <a
      href={staffAttachmentPath(ticketId, uploadId, true)}
      onClick={(event) => void download(event)}
      aria-busy={busy || undefined}
      className={cn(CHIP, "no-underline transition-colors hover:border-primary hover:text-ink aria-busy:cursor-progress")}
    >
      <span className="sr-only">Download </span>
      {label}
      {busy ? <Spinner size="sm" /> : <Icon name="download" size={15} className="text-ink-3" />}
    </a>
  );
}

function MessageTag({ message }: { message: AdminTicketMessage }) {
  if (message.internal) {
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-pill bg-peach-bg px-2 py-0.5 text-[11.5px] font-extrabold text-peach-fg">
        <Icon name="lock" size={13} />
        Internal note
      </span>
    );
  }
  return (
    <span className={cn("whitespace-nowrap text-[12px] font-bold", message.author.isStaff ? "text-lavender-fg" : "text-sage-fg")}>
      {message.author.isStaff ? "Staff" : "Customer"}
    </span>
  );
}

/**
 * The ticket's conversation (prototype drawer section "Conversation"), oldest first: "{author} · {when}", the message
 * and its attachments, tagged Customer or Staff. Internal notes sit on a peach background with an "Internal note" tag
 * and a screen-reader note that the customer never sees them.
 */
export function TicketConversation({ ticketId, messages, now }: { ticketId: string; messages: readonly AdminTicketMessage[]; now: Date }) {
  return (
    <ol className="m-0 list-none p-0" aria-label="Messages, oldest first">
      {messages.map((message) => (
        <li
          key={message.id}
          className={cn(
            "flex items-start gap-2.5 border-b border-line-subtle px-3 py-[9px] text-[13px] last:border-b-0",
            message.internal && "border-l-[3px] border-l-peach-line bg-peach-soft pl-[9px]",
          )}
        >
          <div className="grid min-w-0 flex-1 gap-1">
            <p className="m-0 break-words font-bold">
              {messageAuthorLabel(message)} {"\u00B7"}{" "}
              <time dateTime={message.createdAt} title={formatTicketDateTime(message.createdAt)}>
                {relativeTicketTime(message.createdAt, now)}
              </time>
              {message.internal ? <span className="sr-only"> (internal note, never shown to the customer)</span> : null}
            </p>
            <p className="m-0 whitespace-pre-wrap break-words text-[12.5px] font-semibold leading-normal text-ink-2">{message.body}</p>
            {message.attachments.length > 0 ? (
              <ul className="m-0 mt-1 flex list-none flex-wrap gap-1.5 p-0" aria-label="Attachments">
                {message.attachments.map((attachment, i) => (
                  <li key={attachment.id ?? `${attachment.name}:${i}`} className="min-w-0 max-w-full">
                    <StaffAttachment ticketId={ticketId} attachment={attachment} />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <MessageTag message={message} />
        </li>
      ))}
    </ol>
  );
}
