/**
 * Support tickets and ticket attachments (portal "Support tickets", "New support ticket", "Ticket detail";
 * docs/decisions.md Phase 5 "Tickets"): request bodies (strict, unknown keys rejected), the list query string, the
 * status/priority/impact vocabulary and the attachment allowlist. Copy is the prototype's
 * (design_handoff_axiomatic/prototype/Customer Portal.dc.html). Client-safe: the portal forms reuse these schemas.
 */
import { z } from "zod";

export const TICKET_SUBJECT_MIN = 6;
export const TICKET_SUBJECT_MAX = 150;
export const TICKET_BODY_MIN = 20;
export const TICKET_BODY_MAX = 10_000;
/** Attachments per message (new ticket or reply). */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_NAME_MAX = 150;
/** Ticket list page size (the prototype has no paging; the DataTable pages at this size). */
export const TICKETS_PAGE_SIZE = 20;
/** RESOLVED tickets count as CLOSED this many days after resolution: they can no longer be reopened. */
export const TICKET_AUTO_CLOSE_DAYS = 14;
/** Ticket and upload request bodies; a 10,000-character message in UTF-8 fits comfortably. */
export const TICKET_BODY_MAX_BYTES = 64 * 1024;
export const UPLOAD_BODY_MAX_BYTES = 4 * 1024;
/** POST /api/account/tickets/:id/status and the upload confirm/download calls carry (almost) nothing. */
export const TICKET_ACTION_BODY_MAX_BYTES = 1024;

export const TICKET_ERRORS = {
  product: "Choose a product.",
  license: "Choose one of your licenses for this product, or None.",
  subject: "Add a short subject (at least 6 characters).",
  subjectTooLong: `Use ${TICKET_SUBJECT_MAX} characters or fewer.`,
  body: "Please describe the problem in a bit more detail (20+ characters).",
  bodyTooLong: "Use 10,000 characters or fewer.",
  reply: "Write a message before sending.",
  impact: "Choose how much this affects you.",
  characters: "Remove control characters from the text.",
  attachments: `Attach up to ${MAX_ATTACHMENTS} files.`,
  attachmentDuplicate: "Each file can be attached once.",
  attachmentUnavailable: "One of the attachments isn’t available any more. Remove it and attach it again.",
  fileType: "Attach PNG, JPEG, PDF or TXT files.",
  fileTooLarge: "Each file can be up to 10 MB.",
  fileEmpty: "This file is empty.",
  fileName: "This file needs a name.",
  fileNameTooLong: `Use a file name of ${ATTACHMENT_NAME_MAX} characters or fewer.`,
  action: "Choose resolve or reopen.",
  status: "Choose a valid status.",
  sort: "Choose a valid sort order.",
  page: "Choose a valid page.",
  search: "Use 100 characters or fewer.",
} as const;

// ---------- Vocabulary ----------

/** "T-3018"; the human ids come from Counter "ticket". */
export const TICKET_ID_RE = /^T-[0-9]{1,12}$/;
/** cuid ids (uploads) and the seed's readable ids. */
export const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PRODUCT_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const LICENSE_ID_RE = /^LIC-[A-Z0-9]{1,32}$/;

export function isTicketIdShape(value: string): boolean {
  return TICKET_ID_RE.test(value);
}

export function isUploadIdShape(value: string): boolean {
  return UPLOAD_ID_RE.test(value);
}

/** Impact on the "New support ticket" form -> SupportTicket.priority. */
export const TICKET_IMPACTS = ["low", "normal", "high"] as const;
export type TicketImpact = (typeof TICKET_IMPACTS)[number];
export const TICKET_IMPACT_META: Readonly<Record<TicketImpact, { label: string; hint: string; priority: "LOW" | "NORMAL" | "HIGH" }>> = {
  low: { label: "Low", hint: "Question or how-to", priority: "LOW" },
  normal: { label: "Normal", hint: "Something isn’t working as expected", priority: "NORMAL" },
  high: { label: "High", hint: "Billing is blocked at the counter", priority: "HIGH" },
};
export const DEFAULT_TICKET_IMPACT: TicketImpact = "normal";

export type TicketPriorityKey = TicketImpact;
export const TICKET_PRIORITY_LABELS: Readonly<Record<TicketPriorityKey, string>> = { low: "Low", normal: "Normal", high: "High" };

/**
 * Status as the portal shows it. "closed" is CLOSED, or RESOLVED for more than TICKET_AUTO_CLOSE_DAYS (new copy: the
 * prototype has no label for it). Tones map to the portal badge colours.
 */
export const TICKET_STATUSES = ["open", "awaiting_customer", "resolved", "closed"] as const;
export type TicketStatusKey = (typeof TICKET_STATUSES)[number];
export const TICKET_STATUS_META: Readonly<Record<TicketStatusKey, { label: string; tone: "blue" | "peach" | "sage" | "neutral" }>> = {
  open: { label: "Waiting for support", tone: "blue" },
  awaiting_customer: { label: "Waiting for you", tone: "peach" },
  resolved: { label: "Resolved", tone: "sage" },
  closed: { label: "Closed", tone: "neutral" },
};

/** List tabs: Open = anything not resolved or closed; Resolved includes closed tickets. Default "all" (prototype). */
export const TICKET_STATUS_FILTERS = ["open", "awaiting_customer", "resolved", "all"] as const;
export type TicketStatusFilter = (typeof TICKET_STATUS_FILTERS)[number];
export const TICKET_STATUS_FILTER_LABELS: Readonly<Record<TicketStatusFilter, string>> = {
  open: "Open",
  awaiting_customer: "Needs your reply",
  resolved: "Resolved",
  all: "All",
};

export const TICKET_SORT_KEYS = ["updated", "created", "priority", "status", "subject"] as const;
export type TicketSortKey = (typeof TICKET_SORT_KEYS)[number];
/** Default: most recently updated first (prototype). */
export const DEFAULT_TICKET_SORT = "-updated";

// ---------- Attachments ----------

/** Allowed attachment types and the file extensions each may carry (the download name keeps the extension). */
export const ATTACHMENT_TYPES = {
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "application/pdf": [".pdf"],
  "text/plain": [".txt", ".log"],
} as const satisfies Record<string, readonly string[]>;
export type AttachmentContentType = keyof typeof ATTACHMENT_TYPES;
export const ATTACHMENT_CONTENT_TYPES = Object.keys(ATTACHMENT_TYPES) as AttachmentContentType[];
/** For `<input type="file" accept>`. */
export const ATTACHMENT_ACCEPT = [...ATTACHMENT_CONTENT_TYPES, ...Object.values(ATTACHMENT_TYPES).flat()].join(",");

export function isAttachmentContentType(value: string): value is AttachmentContentType {
  return Object.prototype.hasOwnProperty.call(ATTACHMENT_TYPES, value);
}

/** Lower-cased extension including the dot (".png"), or "" when the name has none. */
export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot).toLowerCase() : "";
}

/**
 * The allowlisted type for a file, when both the declared content type and the name's extension agree; null otherwise.
 * Browsers report "" for unknown types, and an "image/png" called "setup.exe" is refused, so a teammate can never be
 * handed an executable under a harmless type.
 */
export function attachmentTypeFor(fileName: string, contentType: string): AttachmentContentType | null {
  const type = contentType.trim().toLowerCase().split(";")[0]?.trim() ?? "";
  if (!isAttachmentContentType(type)) return null;
  const extensions: readonly string[] = ATTACHMENT_TYPES[type];
  return extensions.includes(fileExtension(fileName)) ? type : null;
}

// ---------- Text ----------

/** C0/C1 control characters other than tab and newlines, and the Unicode line/paragraph separators. */
function hasControlCharacters(value: string, allowNewlines: boolean): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (allowNewlines && (c === 0x09 || c === 0x0a || c === 0x0d)) continue;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

/** NFC, CRLF -> LF, trailing spaces on each line dropped, at most two blank lines in a row, trimmed. */
export function normalizeMessage(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

/** One line: NFC, inner whitespace collapsed, trimmed. */
export function normalizeLine(value: string): string {
  return value.normalize("NFC").replace(/\s+/g, " ").trim();
}

const subjectSchema = z
  .string({ error: TICKET_ERRORS.subject })
  .refine((v) => !hasControlCharacters(v.replace(/[\t\r\n]/g, " "), false), { message: TICKET_ERRORS.characters })
  .transform(normalizeLine)
  .pipe(
    z
      .string()
      .refine((v) => Array.from(v).length >= TICKET_SUBJECT_MIN, { message: TICKET_ERRORS.subject })
      .refine((v) => Array.from(v).length <= TICKET_SUBJECT_MAX, { message: TICKET_ERRORS.subjectTooLong }),
  );

function messageSchema(minMessage: string, min: number) {
  return z
    .string({ error: minMessage })
    .refine((v) => !hasControlCharacters(v, true), { message: TICKET_ERRORS.characters })
    .transform(normalizeMessage)
    .pipe(
      z
        .string()
        .refine((v) => Array.from(v).length >= min, { message: minMessage })
        .refine((v) => Array.from(v).length <= TICKET_BODY_MAX, { message: TICKET_ERRORS.bodyTooLong }),
    );
}

const attachmentIdsSchema = z
  .array(z.string().regex(UPLOAD_ID_RE, { message: TICKET_ERRORS.attachmentUnavailable }), { error: TICKET_ERRORS.attachments })
  .max(MAX_ATTACHMENTS, { message: TICKET_ERRORS.attachments })
  .refine((ids) => new Set(ids).size === ids.length, { message: TICKET_ERRORS.attachmentDuplicate })
  .default([]);

// ---------- Bodies ----------

/**
 * POST /api/account/tickets. `licenseId` is optional ("Related license (optional)"); the server checks that the
 * product exists and that the license belongs to the account and the product. Attachment ids come from
 * POST /api/account/uploads (uploaded and confirmed by the same user).
 */
export const createTicketSchema = z.strictObject({
  productId: z.string({ error: TICKET_ERRORS.product }).regex(PRODUCT_ID_RE, { message: TICKET_ERRORS.product }),
  licenseId: z
    .union([z.null(), z.literal(""), z.string().regex(LICENSE_ID_RE, { message: TICKET_ERRORS.license })], { error: TICKET_ERRORS.license })
    .optional()
    .transform((v) => (v ? v : null)),
  subject: subjectSchema,
  impact: z.enum(TICKET_IMPACTS, { message: TICKET_ERRORS.impact }).default(DEFAULT_TICKET_IMPACT),
  body: messageSchema(TICKET_ERRORS.body, TICKET_BODY_MIN),
  attachmentIds: attachmentIdsSchema,
});
export type CreateTicketInput = z.output<typeof createTicketSchema>;

/** POST /api/account/tickets/:id/messages. */
export const ticketReplySchema = z.strictObject({
  body: messageSchema(TICKET_ERRORS.reply, 1),
  attachmentIds: attachmentIdsSchema,
});
export type TicketReplyInput = z.output<typeof ticketReplySchema>;

/** POST /api/account/tickets/:id/status. */
export const ticketStatusSchema = z.strictObject({
  action: z.enum(["resolve", "reopen"], { message: TICKET_ERRORS.action }),
});
export type TicketStatusInput = z.output<typeof ticketStatusSchema>;

/**
 * POST /api/account/uploads { fileName, contentType, sizeBytes }: one attachment, before the browser PUTs it.
 * The type must be allowlisted and match the name's extension; 1 byte to 10 MB.
 */
export const uploadRequestSchema = z
  .strictObject({
    fileName: z
      .string({ error: TICKET_ERRORS.fileName })
      .refine((v) => !hasControlCharacters(v, false), { message: TICKET_ERRORS.fileName })
      .transform(normalizeLine)
      .pipe(
        z
          .string()
          .min(1, { message: TICKET_ERRORS.fileName })
          .refine((v) => Array.from(v).length <= ATTACHMENT_NAME_MAX, { message: TICKET_ERRORS.fileNameTooLong }),
      ),
    contentType: z.string({ error: TICKET_ERRORS.fileType }).max(100, { message: TICKET_ERRORS.fileType }),
    sizeBytes: z
      .number({ error: TICKET_ERRORS.fileTooLarge })
      .int({ message: TICKET_ERRORS.fileTooLarge })
      .min(1, { message: TICKET_ERRORS.fileEmpty })
      .max(MAX_ATTACHMENT_BYTES, { message: TICKET_ERRORS.fileTooLarge }),
  })
  .transform((v, ctx) => {
    const type = attachmentTypeFor(v.fileName, v.contentType);
    if (!type) {
      ctx.addIssue({ code: "custom", path: ["contentType"], message: TICKET_ERRORS.fileType });
      return z.NEVER;
    }
    return { fileName: v.fileName, contentType: type, sizeBytes: v.sizeBytes };
  });
export type UploadRequestInput = z.output<typeof uploadRequestSchema>;

// ---------- List query ----------

export type TicketListQuery = {
  status: TicketStatusFilter;
  /** Product id, or "all". */
  product: string;
  /** Ticket id or subject ("" = no search). */
  q: string;
  sort: { key: TicketSortKey; dir: 1 | -1 };
  /** 1-based. */
  page: number;
};

const ticketListQuerySchema = z.strictObject({
  status: z.enum(TICKET_STATUS_FILTERS, { message: TICKET_ERRORS.status }).default("all"),
  product: z.union([z.literal("all"), z.string().regex(PRODUCT_ID_RE)], { message: TICKET_ERRORS.product }).default("all"),
  q: z.string().trim().max(100, { message: TICKET_ERRORS.search }).default(""),
  sort: z
    .string()
    .regex(new RegExp(`^-?(${TICKET_SORT_KEYS.join("|")})$`), { message: TICKET_ERRORS.sort })
    .default(DEFAULT_TICKET_SORT),
  page: z.coerce.number({ error: TICKET_ERRORS.page }).int({ message: TICKET_ERRORS.page }).min(1, { message: TICKET_ERRORS.page }).max(100_000).default(1),
});

function pick(params: URLSearchParams, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null && value.trim() !== "") out[key] = value;
  }
  return out;
}

/** Parses GET /api/account/tickets?status=&product=&q=&sort=&page= ("-key" = descending). Throws ZodError (422). */
export function parseTicketListQuery(params: URLSearchParams): TicketListQuery {
  const parsed = ticketListQuerySchema.parse(pick(params, ["status", "product", "q", "sort", "page"]));
  const desc = parsed.sort.startsWith("-");
  return {
    status: parsed.status,
    product: parsed.product,
    q: parsed.q,
    sort: { key: (desc ? parsed.sort.slice(1) : parsed.sort) as TicketSortKey, dir: desc ? -1 : 1 },
    page: parsed.page,
  };
}
