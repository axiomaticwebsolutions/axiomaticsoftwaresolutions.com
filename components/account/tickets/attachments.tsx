"use client";

import * as React from "react";
import { Icon } from "@/components/icons/icon";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { ATTACHMENT_ACCEPT } from "@/lib/validation/tickets";
import { ATTACHMENT_COPY, removeLabel, retryLabel, type AttachmentItem } from "@/components/account/tickets/attachments-model";
import type { AttachmentsController } from "@/components/account/tickets/use-attachments";
import type { AttachmentView } from "@/lib/portal/uploads";

/** Prototype "Attach" button: 7x12px, radius 9, line-input border, 13px/700, 17px attach_file icon. */
const ATTACH_BUTTON =
  "relative inline-flex cursor-pointer items-center gap-1.5 rounded-9 border border-line-input bg-surface px-3 py-[7px] text-[13px] font-bold text-ink transition-colors hover:border-primary " +
  "has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-primary";

/**
 * The "Attach" / "Attach screenshots" button: a styled label around a visually hidden multiple file input (PNG,
 * JPEG, PDF, TXT), so keyboard users reach the native picker and the label names it.
 */
export function AttachButton({
  label,
  controller,
  id,
  describedBy,
  invalid,
}: {
  label: string;
  controller: AttachmentsController;
  id?: string;
  describedBy?: string;
  invalid?: boolean;
}) {
  return (
    <label className={cn(ATTACH_BUTTON, invalid && "border-danger-border")}>
      <Icon name="attach_file" size={17} />
      {label}
      <input
        id={id}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        className="sr-only"
        onChange={(event) => {
          controller.add(event.currentTarget.files);
          // Picking the same file again after removing it must fire another change.
          event.currentTarget.value = "";
        }}
      />
    </label>
  );
}

function ChipButton({ label, icon, onClick, tone }: { label: string; icon: "close" | "restart_alt"; onClick: () => void; tone: "neutral" | "error" }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid size-6 shrink-0 cursor-pointer place-items-center rounded-6 border-0 bg-transparent p-0 transition-colors",
        tone === "error" ? "text-danger hover:bg-pink-line" : "text-ink-2 hover:bg-line hover:text-ink",
      )}
    >
      <Icon name={icon} size={icon === "close" ? 15 : 16} />
    </button>
  );
}

/** One picked file: "name · size" (prototype pending chip), upload progress, remove and retry. */
function PendingChip({ item, controller }: { item: AttachmentItem; controller: AttachmentsController }) {
  const error = item.status === "error";
  const uploading = item.status === "uploading";
  return (
    <span
      className={cn(
        "relative inline-flex max-w-full items-center gap-1.5 overflow-hidden rounded-9 py-[3px] pl-[9px] pr-1 text-[12.5px] font-bold",
        error ? "bg-pink-bg text-danger" : "bg-slate-bg text-ink",
      )}
    >
      {uploading ? <Spinner size="sm" /> : error ? <Icon name="error" size={15} /> : null}
      <span className="min-w-0 truncate">{item.name}</span>
      <span aria-hidden="true">{"\u00B7"}</span>
      <span className="shrink-0 whitespace-nowrap">
        <span className="sr-only">, </span>
        {item.sizeLabel}
      </span>
      {uploading ? (
        <span className="tabular-nums text-ink-2" aria-hidden="true">
          {item.progress}%
        </span>
      ) : null}
      {error ? <ChipButton label={retryLabel(item.name)} icon="restart_alt" tone="error" onClick={() => controller.retry(item.key)} /> : null}
      <ChipButton label={removeLabel(item.name)} icon="close" tone={error ? "error" : "neutral"} onClick={() => controller.remove(item.key)} />
      {uploading ? (
        <span
          role="progressbar"
          aria-label={`${ATTACHMENT_COPY.uploading} ${item.name}`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={item.progress}
          className="absolute inset-x-0 bottom-0 h-0.5 bg-line forced-color-adjust-none"
        >
          <span className="block h-full bg-primary transition-[width] duration-150" style={{ width: `${item.progress}%` }} />
        </span>
      ) : null}
    </span>
  );
}

/** The picked files as chips (inline, after the Attach button). */
export function AttachmentChips({ controller }: { controller: AttachmentsController }) {
  return (
    <>
      {controller.items.map((item) => (
        <PendingChip key={item.key} item={item} controller={controller} />
      ))}
    </>
  );
}

/**
 * Upload errors and refused files under the attach row, plus a polite live region announcing finished uploads.
 * `extra` adds a message from the form (e.g. "Wait for your files to finish uploading.").
 */
export function AttachmentMessages({
  controller,
  id,
  extra,
  className,
}: {
  controller: AttachmentsController;
  id?: string;
  extra?: string | null;
  className?: string;
}) {
  const failed = controller.items.filter((item) => item.status === "error" && item.error);
  const lines = [...controller.messages, ...failed.map((item) => `${item.name}: ${item.error ?? ""}`)];
  if (extra) lines.push(extra);
  return (
    <>
      <span aria-live="polite" className="sr-only">
        {controller.announcement}
      </span>
      {lines.length > 0 ? (
        <ul id={id} role="alert" className={cn("m-0 grid list-none gap-1 p-0", className)}>
          {lines.map((line, i) => (
            <li key={`${i}:${line}`} className="flex items-start gap-1.5 text-[13px] font-semibold text-danger">
              <Icon name="error" size={16} className="mt-px" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

const POSTED_CHIP =
  "inline-flex max-w-full items-center gap-1.5 rounded-9 border border-line-alt bg-surface px-2.5 py-[5px] text-[12.5px] font-bold text-ink";

/** Download path of a ticket attachment (JSON link; `?redirect=1` answers 303 so the plain link also works). */
export function attachmentDownloadPath(id: string, redirect = false): string {
  return `/api/account/uploads/${encodeURIComponent(id)}/download${redirect ? "?redirect=1" : ""}`;
}

/**
 * An attachment of a sent message (prototype chip: attach_file "{name} · {size}"). Downloadable files are links that
 * fetch a 10-minute download link and start the download; sample files without an upload are plain chips.
 */
export function PostedAttachment({ attachment }: { attachment: AttachmentView }) {
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
  if (!attachment.id) return <span className={POSTED_CHIP}>{label}</span>;
  const id = attachment.id;

  async function download(event: React.MouseEvent<HTMLAnchorElement>) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const link = await apiFetch<{ url: string }>(attachmentDownloadPath(id));
      window.location.assign(link.url);
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  return (
    <a
      href={attachmentDownloadPath(id, true)}
      onClick={(event) => void download(event)}
      aria-busy={busy || undefined}
      className={cn(POSTED_CHIP, "no-underline transition-colors hover:border-primary hover:text-ink aria-busy:cursor-progress")}
    >
      <span className="sr-only">Download </span>
      {label}
      {busy ? <Spinner size="sm" /> : <Icon name="download" size={15} className="text-ink-3" />}
    </a>
  );
}
