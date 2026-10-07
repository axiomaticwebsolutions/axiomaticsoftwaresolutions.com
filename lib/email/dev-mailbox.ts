/**
 * In-memory store of the last 50 emails sent through the console transport, listed at /dev/mailbox.
 * Development only: nothing is recorded or returned in production. Kept on globalThis so every route bundle of the
 * dev server (and hot reloads) share one store. It holds full messages (codes and links included) because that is
 * how developers read them; it is never written to disk or logs.
 */
import "server-only";
import { isProduction } from "@/lib/env";

export const DEV_MAILBOX_LIMIT = 50;

export type DevMail = {
  id: string;
  /** ISO time the message was "sent". */
  sentAt: string;
  templateId: string;
  to: string;
  subject: string;
  html: string;
  text: string;
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

/** Empties the store (tests). */
export function clearDevMail(): void {
  store().length = 0;
}
