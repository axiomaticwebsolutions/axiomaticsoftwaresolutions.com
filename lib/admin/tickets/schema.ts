/**
 * Request bodies of the staff ticket API (strict: unknown keys are refused) and their error copy. Pure and
 * client-safe; the console uses the same rules for its inline errors.
 *
 *   PATCH /api/admin/tickets/:id           { status?, priority?, assigneeId? }
 *   POST  /api/admin/tickets/:id/messages  { body, internal, attachmentIds }
 *   POST  /api/admin/tickets/bulk          { action: "assign_to_me" | "resolve", ids }
 *   POST  /api/admin/tickets/:id/uploads   { fileName, contentType, sizeBytes } (lib/validation/tickets uploadRequestSchema)
 */
import { z } from "zod";
import { MAX_ATTACHMENTS, normalizeMessage, TICKET_ID_RE, UPLOAD_ID_RE } from "@/lib/validation/tickets";
import { ADMIN_TICKET_PRIORITIES, ADMIN_TICKET_STATUSES, ASSIGNEE_FILTER_RE, TICKET_BULK_ACTIONS } from "./model";

/** Shortest staff message (prototype: under 2 characters -> "Write a reply first."). */
export const STAFF_MESSAGE_MIN = 2;
export const STAFF_MESSAGE_MAX = 10_000;
export const TICKET_BULK_MAX = 100;
/** Message bodies: 10,000 characters of UTF-8 plus JSON overhead. */
export const STAFF_MESSAGE_BODY_MAX_BYTES = 64 * 1024;
export const TICKET_PATCH_BODY_MAX_BYTES = 2 * 1024;
export const TICKET_BULK_BODY_MAX_BYTES = 8 * 1024;

export const ADMIN_TICKET_ERRORS = {
  reply: "Write a reply first.",
  note: "Write a note first.",
  tooLong: "Use 10,000 characters or fewer.",
  characters: "Remove control characters from the text.",
  internal: "Choose whether this is an internal note.",
  attachments: `Attach up to ${MAX_ATTACHMENTS} files.`,
  attachmentDuplicate: "Each file can be attached once.",
  attachmentUnavailable: "One of the attachments isn’t available any more. Remove it and attach it again.",
  status: "Choose a status.",
  priority: "Choose a priority.",
  assignee: "Choose someone who handles tickets, or Unassigned.",
  nothing: "Change the status, priority or assignee first.",
  action: "Choose Assign to me or Mark resolved.",
  ids: `Select between 1 and ${TICKET_BULK_MAX} tickets.`,
  idsDuplicate: "Each ticket can be selected once.",
} as const;

/** C0/C1 controls other than tab and newlines, and the Unicode line/paragraph separators. */
function hasControlCharacters(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** The error for a staff message as typed (null when it can be sent). Same rules as the server. */
export function staffMessageError(body: string, internal: boolean): string | null {
  const text = normalizeMessage(body);
  const length = Array.from(text).length;
  if (length < STAFF_MESSAGE_MIN) return internal ? ADMIN_TICKET_ERRORS.note : ADMIN_TICKET_ERRORS.reply;
  if (length > STAFF_MESSAGE_MAX) return ADMIN_TICKET_ERRORS.tooLong;
  if (hasControlCharacters(text)) return ADMIN_TICKET_ERRORS.characters;
  return null;
}

/** POST /api/admin/tickets/:id/messages: a public reply (default) or an internal note, with up to 5 uploads. */
export const staffMessageSchema = z
  .strictObject({
    body: z.string({ error: ADMIN_TICKET_ERRORS.reply }).max(STAFF_MESSAGE_MAX * 2, { message: ADMIN_TICKET_ERRORS.tooLong }),
    internal: z.boolean({ error: ADMIN_TICKET_ERRORS.internal }).default(false),
    attachmentIds: z
      .array(z.string().regex(UPLOAD_ID_RE, { message: ADMIN_TICKET_ERRORS.attachmentUnavailable }), { error: ADMIN_TICKET_ERRORS.attachments })
      .max(MAX_ATTACHMENTS, { message: ADMIN_TICKET_ERRORS.attachments })
      .refine((ids) => new Set(ids).size === ids.length, { message: ADMIN_TICKET_ERRORS.attachmentDuplicate })
      .default([]),
  })
  .superRefine((value, ctx) => {
    const error = staffMessageError(value.body, value.internal);
    if (error) ctx.addIssue({ code: "custom", path: ["body"], message: error });
  })
  .transform((value) => ({ ...value, body: normalizeMessage(value.body) }));
export type StaffMessageInput = z.output<typeof staffMessageSchema>;

/** PATCH /api/admin/tickets/:id: any of status, priority and assignee (null = unassigned). */
export const ticketPatchSchema = z
  .strictObject({
    status: z.enum(ADMIN_TICKET_STATUSES, { error: ADMIN_TICKET_ERRORS.status }).optional(),
    priority: z.enum(ADMIN_TICKET_PRIORITIES, { error: ADMIN_TICKET_ERRORS.priority }).optional(),
    assigneeId: z.union([z.null(), z.string().regex(ASSIGNEE_FILTER_RE)], { error: ADMIN_TICKET_ERRORS.assignee }).optional(),
  })
  .refine((v) => v.status !== undefined || v.priority !== undefined || v.assigneeId !== undefined, { message: ADMIN_TICKET_ERRORS.nothing });
export type TicketPatchInput = z.output<typeof ticketPatchSchema>;

/** POST /api/admin/tickets/bulk: the prototype's bulk bar ("Assign to me", "Mark resolved"). */
export const ticketBulkSchema = z.strictObject({
  action: z.enum(TICKET_BULK_ACTIONS, { error: ADMIN_TICKET_ERRORS.action }),
  ids: z
    .array(z.string().regex(TICKET_ID_RE, { message: ADMIN_TICKET_ERRORS.ids }), { error: ADMIN_TICKET_ERRORS.ids })
    .min(1, { message: ADMIN_TICKET_ERRORS.ids })
    .max(TICKET_BULK_MAX, { message: ADMIN_TICKET_ERRORS.ids })
    .refine((ids) => new Set(ids).size === ids.length, { message: ADMIN_TICKET_ERRORS.idsDuplicate }),
});
export type TicketBulkInput = z.output<typeof ticketBulkSchema>;

/** Ticket ids in URLs ("T-3018"); anything else is a 404 without a query. */
export function isTicketId(value: string): boolean {
  return TICKET_ID_RE.test(value);
}

/** Upload ids in URLs (cuid). */
export function isUploadId(value: string): boolean {
  return UPLOAD_ID_RE.test(value);
}
