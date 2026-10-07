/**
 * Pure helpers of the staff tickets console (paths, links, labels, the status form's PATCH body). Client-safe, no
 * React, so unit tests import them directly.
 */
import { firstNameOf, type AdminTicketPriority, type AdminTicketStatus } from "@/lib/admin/tickets/model";

export function ticketApiPath(id: string): string {
  return `/api/admin/tickets/${encodeURIComponent(id)}`;
}

/** Upload endpoints of one ticket: presign, or confirm one upload. */
export function ticketUploadsPath(ticketId: string, uploadId?: string): string {
  const base = `${ticketApiPath(ticketId)}/uploads`;
  return uploadId ? `${base}/${encodeURIComponent(uploadId)}/confirm` : base;
}

/** Staff download link of a ticket attachment (JSON; `?redirect=1` answers 303 so the plain link also works). */
export function staffAttachmentPath(ticketId: string, uploadId: string, redirect = false): string {
  return `${ticketApiPath(ticketId)}/attachments/${encodeURIComponent(uploadId)}${redirect ? "?redirect=1" : ""}`;
}

/** Links into the other modules: the customer list searched by email, and the license's drawer. */
export function customerHref(email: string): string {
  return `/admin/customers?q=${encodeURIComponent(email)}`;
}

export function licenseHref(licenseId: string): string {
  return `/admin/licenses?id=${encodeURIComponent(licenseId)}`;
}

/** How a message's author reads: staff as the customer sees them ("Sneha · Axiomatic Support"), notes by full name. */
export function messageAuthorLabel(message: { author: { name: string; isStaff: boolean }; internal: boolean }): string {
  if (!message.author.isStaff || message.internal) return message.author.name;
  const first = firstNameOf(message.author.name);
  return first ? `${first} \u00B7 Axiomatic Support` : "Axiomatic Support";
}

export const UNASSIGNED_VALUE = "none";

export type TicketMetaValues = { status: AdminTicketStatus; priority: AdminTicketPriority; assigneeId: string | null };

export type TicketMetaPatch = { status?: AdminTicketStatus; priority?: AdminTicketPriority; assigneeId?: string | null };

/** Only the fields that changed (PATCH body), or null when nothing did. */
export function ticketMetaPatch(current: TicketMetaValues, next: TicketMetaValues): TicketMetaPatch | null {
  const patch: TicketMetaPatch = {};
  if (next.status !== current.status) patch.status = next.status;
  if (next.priority !== current.priority) patch.priority = next.priority;
  if (next.assigneeId !== current.assigneeId) patch.assigneeId = next.assigneeId;
  return Object.keys(patch).length > 0 ? patch : null;
}
