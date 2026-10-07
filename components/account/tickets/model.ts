/**
 * Pure view model of the portal's support ticket pages (Customer Portal prototype: "Support tickets", "Ticket
 * detail", "New support ticket"; decisions.md Phase 5 "Tickets"): copy, priority and status styling, the details
 * panel rows, which composer a ticket shows, and the new-ticket form defaults and validation (the API's own Zod
 * schemas, so the browser and the server agree on every message). Client-safe; no React.
 */
import { licensePath, PORTAL_PATHS } from "@/components/account/portal-nav";
import { formatDateIST } from "@/lib/dates";
import { TEAM_ROLE_META, teamRolesFor, type TeamPermission } from "@/lib/rbac";
import {
  createTicketSchema,
  DEFAULT_TICKET_IMPACT,
  TICKET_IMPACT_META,
  TICKET_IMPACTS,
  ticketReplySchema,
  type CreateTicketInput,
  type TicketImpact,
  type TicketPriorityKey,
  type TicketStatusKey,
} from "@/lib/validation/tickets";
import type { TeamRole } from "@/generated/prisma/enums";

export const TICKETS_COPY = {
  listTitle: "Support tickets",
  listDescription: "Track questions and issues with our support team. Everyone on your team with ticket access can see these.",
  newTicket: "New ticket",
  searchPlaceholder: "Ticket ID or subject",
  searchLabel: "Search tickets",
  statusLabel: "Status",
  productFilter: "Product",
  allProducts: "All products",
  empty: "No tickets here.",
  caption: "Support tickets",
  newTitle: "New support ticket",
  newDescription: "Tell us what’s happening. Screenshots help us solve it faster.",
  product: "Product",
  relatedLicense: "Related license (optional)",
  noLicense: "None",
  subject: "Subject",
  subjectPlaceholder: "Short summary of the problem",
  impact: "Impact",
  describe: "Describe the problem",
  describePlaceholder: "What happened, what you expected, and the version you’re using",
  attachScreenshots: "Attach screenshots",
  submit: "Submit ticket",
  submitting: "Submitting…",
  cancel: "Cancel",
  notFoundTitle: "Ticket not found",
  notFoundBody: "This ticket isn’t on your account.",
  allTickets: "All tickets",
  reply: "Reply",
  replyPlaceholder: "Write your reply…",
  attach: "Attach",
  markResolved: "Mark resolved",
  sendReply: "Send reply",
  sending: "Sending…",
  attachNote: "Up to 5 files, 10 MB each. Never paste a full license key or password.",
  replySent: "Reply sent",
  resolvedToast: "Ticket marked resolved",
  resolvedBanner: "This ticket is resolved.",
  reopen: "Reopen",
  closedBanner: "This ticket is closed.",
  startNew: "Start a new ticket",
  conversation: "Conversation",
  details: "Ticket details",
  noProducts: "There are no products to raise a ticket about yet.",
} as const;

export function ticketCreatedToast(id: string): string {
  return `Ticket ${id} created`;
}

/** "Standard support: first reply within 1 business day · Mon–Sat, 10:00–19:00 IST" (+ "(configurable)" while sample). */
export function supportHoursNote(hours: string, sample: boolean): string {
  const base = `Standard support: first reply within 1 business day \u00B7 ${hours.trim()}`;
  return sample ? `${base} (configurable)` : base;
}

/** Prototype priority colours: High #A3273F, Normal #1F4F8F, Low #4B5567 (all tokens, >= 4.5:1 on white). */
export const PRIORITY_STYLES: Readonly<Record<TicketPriorityKey, { text: string; dot: string }>> = {
  high: { text: "text-danger", dot: "bg-danger" },
  normal: { text: "text-blue-fg", dot: "bg-blue-fg" },
  low: { text: "text-ink-2", dot: "bg-ink-2" },
};

export type TicketBadgeTone = "blue" | "peach" | "sage" | "slate";

/** Badge tone of a ticket status (closed is neutral slate). */
export function ticketStatusTone(status: TicketStatusKey): TicketBadgeTone {
  switch (status) {
    case "open":
      return "blue";
    case "awaiting_customer":
      return "peach";
    case "resolved":
      return "sage";
    default:
      return "slate";
  }
}

function joinRoles(perm: TeamPermission): string {
  const roles = teamRolesFor(perm).map((r) => TEAM_ROLE_META[r].label);
  if (roles.length <= 1) return roles[0] ?? "";
  return `${roles.slice(0, -1).join(", ")} or ${roles[roles.length - 1]}`;
}

/** "Replying needs Owner, Billing admin or Technical contact access. You’re signed in as Viewer." */
export function readOnlyNotice(role: TeamRole, perm: TeamPermission = "tickets.create"): string {
  return `Replying needs ${joinRoles(perm)} access. You\u2019re signed in as ${TEAM_ROLE_META[role].label}.`;
}

// ---------- Ticket detail ----------

/** The fields of a ticket the details panel reads (TicketDetail["ticket"]). */
export type TicketMetaInput = {
  statusLabel: string;
  priorityLabel: string;
  productShortName: string | null;
  productName: string | null;
  licenseId: string | null;
  assigneeLabel: string;
  raisedBy: string;
  createdAt: string;
  updatedAt: string;
  replyTarget: string;
};

export type TicketMetaRow = { key: string; label: string; value: string; href?: string };

/**
 * The details panel in prototype order (Status, Priority, Product, Assigned to, Opened, Last update, Reply target),
 * plus the related license and who opened the ticket. `relative` formats "Last update" ("10h ago").
 */
export function ticketMetaRows(ticket: TicketMetaInput, relative: (at: Date) => string): TicketMetaRow[] {
  const rows: TicketMetaRow[] = [
    { key: "status", label: "Status", value: ticket.statusLabel },
    { key: "priority", label: "Priority", value: ticket.priorityLabel },
    { key: "product", label: "Product", value: ticket.productShortName ?? ticket.productName ?? "\u2014" },
  ];
  if (ticket.licenseId) rows.push({ key: "license", label: "License", value: ticket.licenseId, href: licensePath(ticket.licenseId) });
  rows.push(
    { key: "assignee", label: "Assigned to", value: ticket.assigneeLabel },
    { key: "openedBy", label: "Opened by", value: ticket.raisedBy },
    { key: "opened", label: "Opened", value: formatDateIST(new Date(ticket.createdAt)) },
    { key: "updated", label: "Last update", value: relative(new Date(ticket.updatedAt)) },
    { key: "target", label: "Reply target", value: ticket.replyTarget },
  );
  return rows;
}

/**
 * What sits under the conversation: the reply form (open tickets, roles with tickets.create), a read-only note
 * (open tickets, Viewer), the "resolved" banner with Reopen, or the "closed" banner.
 */
export type TicketComposer = "reply" | "readonly" | "resolved" | "closed";

export function ticketComposer(status: TicketStatusKey, canCreate: boolean): TicketComposer {
  if (status === "resolved") return "resolved";
  if (status === "closed") return "closed";
  return canCreate ? "reply" : "readonly";
}

/** "Start a new ticket" from a closed one: the new-ticket form starts on the same product and license. */
export function followUpTicketHref(ticket: { productId: string | null; licenseId: string | null }): string {
  const params = new URLSearchParams();
  if (ticket.productId) params.set("product", ticket.productId);
  if (ticket.licenseId) params.set("license", ticket.licenseId);
  const query = params.toString();
  return query ? `${PORTAL_PATHS.newTicket}?${query}` : PORTAL_PATHS.newTicket;
}

/** Change of the nav badge (open + waiting tickets) when a ticket moves from one status to another. */
export function openCountDelta(before: TicketStatusKey, after: TicketStatusKey): number {
  const open = (s: TicketStatusKey) => s === "open" || s === "awaiting_customer";
  return (open(after) ? 1 : 0) - (open(before) ? 1 : 0);
}

/** Reply validation with the API's schema: the message, or null when the reply can be sent. */
export function replyError(body: string): string | null {
  const parsed = ticketReplySchema.safeParse({ body, attachmentIds: [] });
  if (parsed.success) return null;
  return parsed.error.issues.find((i) => i.path[0] === "body")?.message ?? parsed.error.issues[0]?.message ?? null;
}

// ---------- New ticket ----------

export type NewTicketProduct = { id: string; name: string };
export type NewTicketLicense = { id: string; productId: string; planName: string };

export type NewTicketValues = {
  productId: string;
  licenseId: string;
  subject: string;
  impact: TicketImpact;
  body: string;
};

export type NewTicketField = "productId" | "licenseId" | "subject" | "impact" | "body" | "attachmentIds";

/** Field order for the error summary (the form's order). */
export const NEW_TICKET_FIELDS: readonly NewTicketField[] = ["productId", "licenseId", "subject", "impact", "body", "attachmentIds"];

/** Ids of the form controls (the error summary links to them). */
export const NEW_TICKET_FIELD_IDS: Readonly<Record<NewTicketField, string>> = {
  productId: "ticket-product",
  licenseId: "ticket-license",
  subject: "ticket-subject",
  impact: "ticket-impact-normal",
  body: "ticket-body",
  attachmentIds: "ticket-attachments",
};

/** Impact radio cards in prototype order with their copy. */
export const IMPACT_OPTIONS: readonly { value: TicketImpact; label: string; hint: string }[] = TICKET_IMPACTS.map((value) => ({
  value,
  label: TICKET_IMPACT_META[value].label,
  hint: TICKET_IMPACT_META[value].hint,
}));

/** "LIC-24017 · Annual license" options for the chosen product. */
export function licenseOptionsFor(licenses: readonly NewTicketLicense[], productId: string): { value: string; label: string }[] {
  return licenses.filter((l) => l.productId === productId).map((l) => ({ value: l.id, label: `${l.id} \u00B7 ${l.planName}` }));
}

/**
 * Starting product and license: ?license= (one of the account's licenses) picks its product too, else ?product=,
 * else the first product the account holds a license for, else the first product (prototype default: the first).
 */
export function initialTicketTarget(
  products: readonly NewTicketProduct[],
  licenses: readonly NewTicketLicense[],
  prefill: { product?: string | null; license?: string | null } = {},
): { productId: string; licenseId: string } {
  const listed = (id: string | null | undefined) => !!id && products.some((p) => p.id === id);
  const license = prefill.license ? licenses.find((l) => l.id === prefill.license) : undefined;
  if (license && listed(license.productId)) return { productId: license.productId, licenseId: license.id };
  if (prefill.product && listed(prefill.product)) return { productId: prefill.product, licenseId: "" };
  const licensed = products.find((p) => licenses.some((l) => l.productId === p.id));
  return { productId: licensed?.id ?? products[0]?.id ?? "", licenseId: "" };
}

export function emptyNewTicket(target: { productId: string; licenseId: string }): NewTicketValues {
  return { productId: target.productId, licenseId: target.licenseId, subject: "", impact: DEFAULT_TICKET_IMPACT, body: "" };
}

export type NewTicketErrors = Partial<Record<NewTicketField, string>>;

function isField(value: unknown): value is NewTicketField {
  return typeof value === "string" && (NEW_TICKET_FIELDS as readonly string[]).includes(value);
}

/** The first message per field. */
function firstPerField(entries: Iterable<readonly [unknown, string]>): NewTicketErrors {
  const out: NewTicketErrors = {};
  for (const [field, message] of entries) {
    if (isField(field) && out[field] === undefined) out[field] = message;
  }
  return out;
}

/** Validates the form with the API's schema; the request body when valid. */
export function validateNewTicket(
  values: NewTicketValues,
  attachmentIds: readonly string[],
): { ok: true; data: CreateTicketInput } | { ok: false; errors: NewTicketErrors } {
  const parsed = createTicketSchema.safeParse({ ...values, attachmentIds: [...attachmentIds] });
  if (parsed.success) return { ok: true, data: parsed.data };
  return { ok: false, errors: firstPerField(parsed.error.issues.map((i) => [i.path[0], i.message] as const)) };
}

/** Field errors of a 422 from POST /api/account/tickets ("attachmentIds.0" counts as attachmentIds). */
export function newTicketErrorsFromApi(fieldErrors: Readonly<Record<string, readonly string[]>>): NewTicketErrors {
  const entries: (readonly [unknown, string])[] = [];
  for (const [key, messages] of Object.entries(fieldErrors)) {
    const message = messages[0];
    if (message) entries.push([key.split(".")[0], message]);
  }
  return firstPerField(entries);
}

/** Error summary entries in form order. */
export function newTicketSummary(errors: NewTicketErrors): { fieldId: string; message: string }[] {
  return NEW_TICKET_FIELDS.flatMap((field) => {
    const message = errors[field];
    return message ? [{ fieldId: NEW_TICKET_FIELD_IDS[field], message }] : [];
  });
}
