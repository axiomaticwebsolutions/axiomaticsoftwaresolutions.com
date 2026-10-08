/**
 * In-memory store of the last 50 emails sent through the console transport, listed at /dev/mailbox.
 * Development only: nothing is recorded or returned in production. Kept on globalThis so every route bundle of the
 * dev server (and hot reloads) share one store. It holds full messages (codes and links included) because that is
 * how developers read them; it is never written to disk or logs. Attachments (the order email's invoice PDF) are kept
 * with their bytes so the mailbox can offer them for download (GET /api/dev/mailbox/:id/attachments/:index, also
 * development only); a few PDFs of tens of kB each, gone on restart.
 */
import "server-only";
import { isProduction } from "@/lib/env";

export const DEV_MAILBOX_LIMIT = 50;

export type DevMailAttachment = {
  filename: string;
  contentType: string;
  /** Bytes, shown next to the name. */
  size: number;
  content: Buffer;
};

export type DevMail = {
  id: string;
  /** ISO time the message was "sent". */
  sentAt: string;
  templateId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: DevMailAttachment[];
};

const holder = globalThis as unknown as { __axsDevMailbox?: DevMail[] };

function store(): DevMail[] {
  holder.__axsDevMailbox ??= [];
  return holder.__axsDevMailbox;
}

/** Adds a message (newest first) and drops the oldest beyond DEV_MAILBOX_LIMIT. No-op in production. */
export function recordDevMail(mail: DevMail): void {
  if (isProduction()) return;
  const list = store();
  list.unshift(mail);
  if (list.length > DEV_MAILBOX_LIMIT) list.length = DEV_MAILBOX_LIMIT;
}

/** Newest first. Empty in production. */
export function listDevMail(): DevMail[] {
  return isProduction() ? [] : [...store()];
}

export function getDevMail(id: string): DevMail | null {
  return listDevMail().find((m) => m.id === id) ?? null;
}

/** Attachment `index` (0-based) of message `id`, or null (always null in production). */
export function getDevMailAttachment(id: string, index: number): DevMailAttachment | null {
  if (!Number.isInteger(index) || index < 0) return null;
  return getDevMail(id)?.attachments?.[index] ?? null;
}

/** Empties the store (tests). */
export function clearDevMail(): void {
  store().length = 0;
}
