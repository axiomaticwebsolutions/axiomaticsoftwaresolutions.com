/**
 * Ticket attachments in the browser (decisions.md Phase 5 "Tickets": up to 5 files, PNG, JPEG, PDF or TXT, 10 MB
 * each, presigned upload). Pure checks before anything is uploaded, the state of each picked file, and the messages.
 * The server repeats every check (POST /api/account/uploads, confirm, and again when the message is sent).
 * Client-safe; no React.
 */
import { formatFileSize } from "@/lib/storefront/derive";
import {
  ATTACHMENT_NAME_MAX,
  ATTACHMENT_TYPES,
  attachmentTypeFor,
  fileExtension,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  TICKET_ERRORS,
  type AttachmentContentType,
} from "@/lib/validation/tickets";

export const ATTACHMENT_COPY = {
  uploadFailed: "We couldn’t upload this file. Try again.",
  retry: "Try again",
  waitForUploads: "Wait for your files to finish uploading.",
  removeFailed: "Remove the files that didn’t upload, or try them again.",
  uploading: "Uploading",
} as const;

export function removeLabel(name: string): string {
  return `Remove ${name}`;
}

export function retryLabel(name: string): string {
  return `Try uploading ${name} again`;
}

export function uploadedAnnouncement(name: string): string {
  return `${name} attached`;
}

export function failedAnnouncement(name: string, message: string): string {
  return `${name} wasn\u2019t attached. ${message}`;
}

/** "scanner.heic: Attach PNG, JPEG, PDF or TXT files." */
export function rejectedFileMessage(name: string, message: string): string {
  return `${name}: ${message}`;
}

/** What the picker needs from a File (a plain object in tests). */
export type PickedFile = { name: string; size: number; type: string };

/**
 * The allowlisted content type of a picked file: its declared type when that matches the extension, or, when the
 * browser reports none ("" or application/octet-stream, e.g. ".log" on Windows), the type its extension implies.
 */
export function contentTypeForFile(file: PickedFile): AttachmentContentType | null {
  const declared = file.type.trim().toLowerCase();
  if (declared && declared !== "application/octet-stream") return attachmentTypeFor(file.name, declared);
  const ext = fileExtension(file.name);
  for (const [type, extensions] of Object.entries(ATTACHMENT_TYPES) as [AttachmentContentType, readonly string[]][]) {
    if (extensions.includes(ext)) return type;
  }
  return null;
}

export type AttachmentCheck = { ok: true; contentType: AttachmentContentType } | { ok: false; error: string };

/** The checks the upload API makes, with its messages. */
export function checkAttachment(file: PickedFile): AttachmentCheck {
  const name = file.name.trim();
  if (!name) return { ok: false, error: TICKET_ERRORS.fileName };
  if (Array.from(name).length > ATTACHMENT_NAME_MAX) return { ok: false, error: TICKET_ERRORS.fileNameTooLong };
  const contentType = contentTypeForFile(file);
  if (!contentType) return { ok: false, error: TICKET_ERRORS.fileType };
  if (file.size <= 0) return { ok: false, error: TICKET_ERRORS.fileEmpty };
  if (file.size > MAX_ATTACHMENT_BYTES) return { ok: false, error: TICKET_ERRORS.fileTooLarge };
  return { ok: true, contentType };
}

export type AttachmentPlan<F extends PickedFile> = {
  accepted: { file: F; contentType: AttachmentContentType }[];
  rejected: { name: string; error: string }[];
  /** Some valid files did not fit within the limit (prototype: the first five are kept). */
  overLimit: boolean;
};

/** Splits a new selection into files to upload (in order, up to the free slots) and files refused with a reason. */
export function planAttachments<F extends PickedFile>(existing: number, files: readonly F[], max: number = MAX_ATTACHMENTS): AttachmentPlan<F> {
  const plan: AttachmentPlan<F> = { accepted: [], rejected: [], overLimit: false };
  let free = Math.max(0, max - existing);
  for (const file of files) {
    const check = checkAttachment(file);
    if (!check.ok) {
      plan.rejected.push({ name: file.name, error: check.error });
    } else if (free > 0) {
      plan.accepted.push({ file, contentType: check.contentType });
      free -= 1;
    } else {
      plan.overLimit = true;
    }
  }
  return plan;
}

/** Messages shown under the Attach button after a selection (refused files, then the limit). */
export function planMessages(plan: AttachmentPlan<PickedFile>): string[] {
  const messages = plan.rejected.map((r) => rejectedFileMessage(r.name, r.error));
  if (plan.overLimit) messages.push(TICKET_ERRORS.attachments);
  return messages;
}

export type AttachmentStatus = "uploading" | "ready" | "error";

export type AttachmentItem = {
  /** Client key (stable across retries). */
  key: string;
  name: string;
  sizeBytes: number;
  /** "214 KB" */
  sizeLabel: string;
  contentType: AttachmentContentType;
  status: AttachmentStatus;
  /** 0-100 while uploading. */
  progress: number;
  /** Upload id once POST /api/account/uploads answered. */
  uploadId: string | null;
  error: string | null;
};

export function newAttachmentItem(key: string, file: PickedFile, contentType: AttachmentContentType): AttachmentItem {
  return {
    key,
    name: file.name,
    sizeBytes: file.size,
    sizeLabel: formatFileSize(file.size),
    contentType,
    status: "uploading",
    progress: 0,
    uploadId: null,
    error: null,
  };
}

export function uploadPercent(loaded: number, total: number): number {
  if (!Number.isFinite(loaded) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
}

/** Upload ids to send with the message, in the order the files were picked. */
export function readyUploadIds(items: readonly AttachmentItem[]): string[] {
  return items.flatMap((item) => (item.status === "ready" && item.uploadId ? [item.uploadId] : []));
}

/** Why the message cannot be sent yet (files still uploading or failed), or null. */
export function attachmentsBlocker(items: readonly AttachmentItem[]): string | null {
  if (items.some((i) => i.status === "uploading")) return ATTACHMENT_COPY.waitForUploads;
  if (items.some((i) => i.status === "error")) return ATTACHMENT_COPY.removeFailed;
  return null;
}

/** The message of a failed upload API call: a field error (type, size, name) first, then the error's own message. */
export function uploadErrorMessage(error: { message: string; fieldErrors?: Readonly<Record<string, readonly string[]>> }): string {
  const fields = error.fieldErrors ?? {};
  for (const key of ["contentType", "sizeBytes", "fileName"]) {
    const message = fields[key]?.[0];
    if (message) return message;
  }
  const first = Object.values(fields).find((m) => m.length > 0)?.[0];
  return first ?? error.message;
}
