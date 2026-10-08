/**
 * Email attachment references (docs/decisions.md "Invoice PDF attached to the order email"). An outbox row never holds
 * attachment bytes, paths or URLs: it holds typed references (`OutboxEmail.attachments`, e.g.
 * `[{ "kind": "invoice", "orderId": "AX-10312" }]`) that the dispatcher renders at send time (lib/email/attachments.ts).
 *
 * Kinds are a closed allowlist, and each template may carry only the kinds listed for it here: today only
 * order_confirmation carries the order's current tax invoice. A refund or credit-note email would add its own kind
 * (e.g. "credit_note" with the correction id) and list it for its template. References are validated when an email is
 * enqueued (a contract violation) and again when a row is read back (anything unknown or garbled is ignored and logged).
 *
 * Pure and client-safe (Admin > Notification templates reads TEMPLATE_ATTACHMENT_KINDS for its note).
 */

export const EMAIL_ATTACHMENT_KINDS = ["invoice"] as const;
export type EmailAttachmentKind = (typeof EMAIL_ATTACHMENT_KINDS)[number];

/** The order's current tax invoice as a PDF, exactly as GET /api/orders/:id/invoice.pdf serves it at send time. */
export type InvoiceAttachmentRef = { kind: "invoice"; orderId: string };
export type EmailAttachmentRef = InvoiceAttachmentRef;

/** Which templates may carry which kinds. Every other template has no attachments. */
export const TEMPLATE_ATTACHMENT_KINDS: Readonly<Record<string, readonly EmailAttachmentKind[]>> = {
  order_confirmation: ["invoice"],
};

/** At most this many references per email (one invoice today). */
export const MAX_ATTACHMENT_REFS = 4;

/** Order ids are "AX-10312"; this accepts any short id of safe characters and nothing that could be a path or URL. */
const ORDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type AttachmentRefProblem = "not_a_list" | "too_many" | "malformed" | "unknown_kind" | "not_allowed_for_template";

export type ParsedAttachmentRefs = {
  refs: EmailAttachmentRef[];
  /** One entry per ignored reference (or one for the whole value), for the log. Never echoes the value itself. */
  problems: { problem: AttachmentRefProblem; kind?: EmailAttachmentKind }[];
};

export function isEmailAttachmentKind(value: unknown): value is EmailAttachmentKind {
  return typeof value === "string" && (EMAIL_ATTACHMENT_KINDS as readonly string[]).includes(value);
}

/** The kinds a template may carry (empty for every template but the listed ones). */
export function attachmentKindsFor(templateId: string): readonly EmailAttachmentKind[] {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_ATTACHMENT_KINDS, templateId) ? (TEMPLATE_ATTACHMENT_KINDS[templateId] ?? []) : [];
}

function parseOne(value: unknown): EmailAttachmentRef | AttachmentRefProblem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "malformed";
  const record = value as Record<string, unknown>;
  if (!isEmailAttachmentKind(record.kind)) return typeof record.kind === "string" ? "unknown_kind" : "malformed";
  // A closed shape per kind: no extra fields (nothing else can ride along into the dispatcher).
  const keys = Object.keys(record).sort().join(",");
  if (record.kind === "invoice") {
    if (keys !== "kind,orderId" || typeof record.orderId !== "string" || !ORDER_ID_RE.test(record.orderId)) return "malformed";
    return { kind: "invoice", orderId: record.orderId };
  }
  return "unknown_kind";
}

/**
 * Validates the references of an email of `templateId`: a list of known kinds in their exact shape, allowed for the
 * template, at most MAX_ATTACHMENT_REFS, duplicates folded. `null` / `undefined` is "no attachments". A JSON string
 * (a raw query handing back unparsed JSON) is parsed first. Returns the valid references and what was dropped.
 */
export function parseAttachmentRefs(templateId: string, value: unknown): ParsedAttachmentRefs {
  const out: ParsedAttachmentRefs = { refs: [], problems: [] };
  if (value === null || value === undefined) return out;
  let list: unknown = value;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list) as unknown;
    } catch {
      out.problems.push({ problem: "not_a_list" });
      return out;
    }
  }
  if (!Array.isArray(list)) {
    out.problems.push({ problem: "not_a_list" });
    return out;
  }
  if (list.length > MAX_ATTACHMENT_REFS) {
    out.problems.push({ problem: "too_many" });
    return out;
  }
  const allowed = attachmentKindsFor(templateId);
  const seen = new Set<string>();
  for (const item of list) {
    const ref = parseOne(item);
    if (typeof ref === "string") {
      out.problems.push({ problem: ref });
      continue;
    }
    if (!allowed.includes(ref.kind)) {
      out.problems.push({ problem: "not_allowed_for_template", kind: ref.kind });
      continue;
    }
    const key = `${ref.kind}:${ref.orderId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.refs.push(ref);
  }
  return out;
}
