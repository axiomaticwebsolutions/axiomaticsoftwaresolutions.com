"use client";

import * as React from "react";
import { AttachButton, AttachmentChips, AttachmentMessages } from "@/components/account/tickets/attachments";
import { DrawerSubmit } from "@/components/admin/drawer";
import { adminToast } from "@/components/admin/admin-toaster";
import { Icon } from "@/components/icons/icon";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiClientError, apiFetch } from "@/lib/client/api";
import { staffMessageError, STAFF_MESSAGE_MAX } from "@/lib/admin/tickets/schema";
import type { StaffMessageResult } from "@/lib/admin/tickets/service";
import { cn } from "@/lib/utils";
import { useStaffAttachments } from "./use-staff-attachments";

export const REPLY_COPY = {
  replyTitle: "Reply to customer",
  noteTitle: "Internal note",
  internalLabel: "Internal note",
  internalHint: "Only staff can see it. The customer isn\u2019t notified.",
  replyLabel: "Message",
  noteLabel: "Note",
  replyHelp: "Sent by email and shown in the customer\u2019s account. Never include full license keys.",
  noteHelp: "Visible to staff in this console only. It is never shown or sent to the customer.",
  attach: "Attach files",
  sendReply: "Send reply",
  addNote: "Add note",
  replySent: "Reply sent",
  noteAdded: "Internal note added",
} as const;

export type ReplyFormProps = {
  ticketId: string;
  internal: boolean;
  onInternalChange: (internal: boolean) => void;
  /** The ticket after the message was saved. */
  onSent: (result: StaffMessageResult) => void;
};

/**
 * The drawer's reply box (prototype edit card "Reply to customer"): an "Internal note" switch, the message, attachments
 * (PNG, JPEG, PDF or TXT, up to 5, uploaded as they are picked) and the submit. Errors show under the message; the
 * server repeats every check.
 */
export function ReplyForm({ ticketId, internal, onInternalChange, onSent }: ReplyFormProps) {
  const [body, setBody] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  /** A server answer about the attachments (unavailable, attached elsewhere). */
  const [attachError, setAttachError] = React.useState<string | null>(null);
  /** After a send attempt, files still uploading or failed are reported under the attach row. */
  const [tried, setTried] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const attachments = useStaffAttachments(ticketId);
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const switchId = React.useId();
  const attachMessagesId = React.useId();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const problem = staffMessageError(body, internal);
    setTried(true);
    setAttachError(null);
    if (problem) {
      setError(problem);
      textareaRef.current?.focus();
      return;
    }
    setError(null);
    if (attachments.blocker) return;
    setBusy(true);
    try {
      const result = await apiFetch<StaffMessageResult>(`/api/admin/tickets/${encodeURIComponent(ticketId)}/messages`, {
        method: "POST",
        body: { body, internal, attachmentIds: attachments.readyIds },
      });
      setBody("");
      setTried(false);
      attachments.reset();
      onSent(result);
      adminToast.success(internal ? REPLY_COPY.noteAdded : REPLY_COPY.replySent);
    } catch (e) {
      const fields = e instanceof ApiClientError ? e.fieldErrors : {};
      if (fields.body?.[0]) {
        setError(fields.body[0]);
        textareaRef.current?.focus();
      } else if (fields.attachmentIds?.[0]) {
        setAttachError(fields.attachmentIds[0]);
      } else {
        adminToast.error(e);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="grid gap-2.5">
      <div className="flex items-start gap-2.5">
        <Switch
          id={switchId}
          checked={internal}
          onCheckedChange={(checked) => {
            onInternalChange(checked);
            setError(null);
          }}
          aria-describedby={`${switchId}-hint`}
        />
        <div className="grid gap-0.5">
          <Label htmlFor={switchId} size="sm" className="font-bold">
            {REPLY_COPY.internalLabel}
          </Label>
          <p id={`${switchId}-hint`} className="m-0 text-[12px] text-ink-2">
            {REPLY_COPY.internalHint}
          </p>
        </div>
      </div>
      {internal ? (
        <p className="m-0 flex items-center gap-1.5 rounded-9 border border-peach-line bg-peach-soft px-2.5 py-1.5 text-[12.5px] font-bold text-peach-fg">
          <Icon name="lock" size={15} />
          {REPLY_COPY.noteHelp}
        </p>
      ) : null}
      <Field size="sm" label={internal ? REPLY_COPY.noteLabel : REPLY_COPY.replyLabel} hint={internal ? undefined : REPLY_COPY.replyHelp} error={error}>
        <Textarea
          ref={textareaRef}
          size="sm"
          rows={5}
          value={body}
          maxLength={STAFF_MESSAGE_MAX * 2}
          onChange={(event) => {
            setBody(event.target.value);
            if (error) setError(null);
          }}
          className={cn(internal && "border-peach-line bg-peach-soft")}
        />
      </Field>
      <div className="flex flex-wrap items-center gap-1.5">
        <AttachButton label={REPLY_COPY.attach} controller={attachments} describedBy={attachMessagesId} />
        <AttachmentChips controller={attachments} />
      </div>
      <AttachmentMessages controller={attachments} id={attachMessagesId} extra={attachError ?? (tried ? attachments.blocker : null)} />
      <DrawerSubmit disabled={busy} aria-busy={busy || undefined}>
        {internal ? REPLY_COPY.addNote : REPLY_COPY.sendReply}
      </DrawerSubmit>
    </form>
  );
}
