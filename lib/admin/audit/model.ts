/**
 * Audit log (Admin Console.dc.html `mods.audit`; decisions.md Phase 6): list query, DTO, display helpers, CSV columns
 * and copy shared by the service, the API routes and the UI. Pure and client-safe.
 *
 * The log is append-only: there are list, detail and CSV endpoints and nothing that updates or deletes a row.
 * Filters: actor role (System / Owner / Administrator / Support / Finance, the prototype's "Actor" select), one staff
 * member, the action (a slug of its label, so it fits the URL rules of lib/url-state), the target type and an IST
 * date range. Search covers the actor's name, the action, target, target id, detail and reason.
 */
import type { ListQuerySpec } from "@/lib/admin/list-query";
import type { CsvColumn } from "@/lib/csv";
import { defineListState } from "@/lib/url-state";
import { formatAdminDateTimeLong } from "./format";

export const AUDIT_ROLES = ["system", "owner", "admin", "support", "finance"] as const;
export type AuditRoleKey = (typeof AUDIT_ROLES)[number];

export const AUDIT_ROLE_LABELS: Readonly<Record<AuditRoleKey, string>> = {
  system: "System",
  owner: "Owner",
  admin: "Administrator",
  support: "Support",
  finance: "Finance",
};

export function isAuditRole(value: string): value is AuditRoleKey {
  return (AUDIT_ROLES as readonly string[]).includes(value);
}

/** "Administrator" for "admin"; unknown stored roles read as themselves, capitalised. */
export function auditRoleLabel(role: string | null | undefined): string {
  const key = (role ?? "").trim().toLowerCase();
  if (isAuditRole(key)) return AUDIT_ROLE_LABELS[key];
  return key ? key.charAt(0).toUpperCase() + key.slice(1) : "\u2014";
}

export const AUDIT_SORTS = ["createdAt", "actor", "action"] as const;
export type AuditSort = (typeof AUDIT_SORTS)[number];
export const AUDIT_PAGE_SIZE = 25;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ACTOR_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_TYPE_RE = /^[a-z][a-z0-9_.-]{0,39}$/;
const ACTION_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ACTION_SLUG_MAX = 64;

/** A real calendar date "YYYY-MM-DD" (IST day), else undefined. */
export function parseAuditDate(raw: string): string | undefined {
  const m = DATE_RE.exec(raw);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1) return undefined;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return undefined;
  return raw;
}

/** URL-safe key of an action label: "Changed staff role" -> "changed-staff-role". */
export function actionSlug(action: string): string {
  return action
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ACTION_SLUG_MAX)
    .replace(/-+$/, "");
}

export function parseActionSlug(raw: string): string | undefined {
  return raw.length <= ACTION_SLUG_MAX && ACTION_SLUG_RE.test(raw) ? raw : undefined;
}

export const AUDIT_FILTERS = {
  role: AUDIT_ROLES,
  actor: (raw: string) => (ACTOR_ID_RE.test(raw) ? raw : undefined),
  action: parseActionSlug,
  targetType: (raw: string) => (TARGET_TYPE_RE.test(raw) ? raw : undefined),
  from: parseAuditDate,
  to: parseAuditDate,
};

/** GET /api/admin/audit and export.csv: ?q=&filter[role|actor|action|targetType|from|to]=&sort=-createdAt&page=&pageSize= */
export const AUDIT_LIST_SPEC = {
  filters: AUDIT_FILTERS,
  sortable: AUDIT_SORTS,
  defaultSort: { id: "createdAt", desc: true },
  defaultPageSize: AUDIT_PAGE_SIZE,
} as const satisfies ListQuerySpec<typeof AUDIT_FILTERS, AuditSort>;

export type AuditFilterKey = keyof typeof AUDIT_FILTERS;

/** The same list in the page URL (lib/url-state, bracket filters like the API). */
export const AUDIT_LIST_STATE = defineListState<AuditFilterKey>({
  filters: { role: { values: AUDIT_ROLES }, actor: {}, action: {}, targetType: {}, from: {}, to: {} },
  sortable: AUDIT_SORTS,
  defaultSort: { id: "createdAt", desc: true },
  pageSize: AUDIT_PAGE_SIZE,
  filterStyle: "bracket",
});

// ---------- Action labels ----------

/**
 * The payment webhook's system actions in the prototype's sentence-case vocabulary ("Webhook processed"). Rows written
 * before the webhook used these labels hold machine names ("order.paid"); the log is append-only, so they are shown
 * under the label everywhere (list, drawer, filter, CSV, Overview, order history) instead of being rewritten.
 */
export const SYSTEM_AUDIT_ACTIONS = {
  webhookProcessed: "Webhook processed",
  duplicateCapture: "Duplicate payment captured",
  orderReview: "Flagged order for review",
  refundProcessed: "Refund processed",
  refundFailed: "Refund failed",
} as const;

const LEGACY_ACTION_LABELS: ReadonlyMap<string, string> = new Map([
  ["order.paid", SYSTEM_AUDIT_ACTIONS.webhookProcessed],
  ["payment.captured_twice", SYSTEM_AUDIT_ACTIONS.duplicateCapture],
  ["order.review", SYSTEM_AUDIT_ACTIONS.orderReview],
  ["refund.processed", SYSTEM_AUDIT_ACTIONS.refundProcessed],
  ["refund.failed", SYSTEM_AUDIT_ACTIONS.refundFailed],
]);

/** The label an action shows under: "order.paid" (older rows) -> "Webhook processed"; anything else unchanged. */
export function auditActionLabel(action: string): string {
  return LEGACY_ACTION_LABELS.get(action) ?? action;
}

/** Stored action values that show as one of `labels` (the labels themselves plus older machine names). */
export function storedAuditActions(labels: readonly string[]): string[] {
  const wanted = new Set(labels);
  const legacy = [...LEGACY_ACTION_LABELS].filter(([, label]) => wanted.has(label)).map(([stored]) => stored);
  return [...new Set([...labels, ...legacy])];
}

/** Older machine names whose label contains the search text (so searching "webhook" finds "order.paid" rows). */
export function legacyActionsMatching(q: string): string[] {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  return [...LEGACY_ACTION_LABELS].filter(([, label]) => label.toLowerCase().includes(term)).map(([stored]) => stored);
}

// ---------- DTO ----------

/** One audit event as the list, drawer and CSV show it (the IP is already truncated when stored). */
export type AuditRow = {
  id: string;
  at: string;
  actorId: string | null;
  /** "Vikram Rao", "System", or "Former staff member" when the account no longer exists. */
  actorName: string;
  /** owner | admin | support | finance | system */
  actorRole: string;
  action: string;
  target: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  detail: string | null;
  /** Stored prefix ("103.21.44.x"), shown masked. */
  ipPrefix: string | null;
};

export const SYSTEM_ACTOR_NAME = "System";
export const FORMER_STAFF_NAME = "Former staff member";

/** Prototype IP column: "103.21.44.•••" (the stored value already ends in ".x"; IPv6 keeps its /48 network). */
export function maskIp(prefix: string | null | undefined): string {
  if (!prefix) return "\u2014";
  return prefix.endsWith(".x") ? `${prefix.slice(0, -2)}.\u2022\u2022\u2022` : prefix;
}

/** DETAIL column: the detail and the reason ("Support → Finance · moved to accounts"), or an em dash. */
export function auditDetailText(row: Pick<AuditRow, "detail" | "reason">): string {
  const parts = [row.detail, row.reason].map((p) => (p ?? "").trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(" \u00B7 ") : "\u2014";
}

const TARGET_TYPE_LABELS: Readonly<Record<string, string>> = {
  order: "Order",
  license: "License",
  plan: "Plan",
  product: "Product",
  category: "Category",
  release: "Release",
  coupon: "Coupon",
  customer: "Customer",
  account: "Business account",
  ticket: "Ticket",
  lead: "Lead",
  faq: "FAQ",
  template: "Template",
  staff: "Staff",
  settings: "Settings",
  report: "Report",
  webhook: "Webhook",
  payment: "Payment",
  refund: "Refund",
  device: "Device",
};

/** "order" -> "Order", unknown types humanised ("credit_note" -> "Credit note"). */
export function targetTypeLabel(type: string | null | undefined): string {
  if (!type) return "\u2014";
  const known = TARGET_TYPE_LABELS[type];
  if (known) return known;
  const words = type.replace(/[_.-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "\u2014";
}

export type AuditTargetModule = "orders" | "licenses" | "tickets" | "staff" | "customers";

const TARGET_MODULES: Readonly<Record<string, AuditTargetModule>> = {
  order: "orders",
  license: "licenses",
  ticket: "tickets",
  staff: "staff",
  // Customer rows are listed by business account id (Admin > Customers drawer).
  customer: "customers",
};

/** Where a target opens in the console (its module's drawer, ?id=), for types listed by that id. */
export function targetHref(row: Pick<AuditRow, "targetType" | "targetId">): { module: AuditTargetModule; href: string } | null {
  const id = row.targetId?.trim();
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(id) || !row.targetType) return null;
  const target = TARGET_MODULES[row.targetType];
  return target ? { module: target, href: `/admin/${target}?id=${encodeURIComponent(id)}` } : null;
}

// ---------- Filter options ----------

export type AuditOption = { value: string; label: string };

/** Options of the Person, Action and Target selects (loaded by the page; see auditFacets() in the service). */
export type AuditFacets = { actors: AuditOption[]; actions: AuditOption[]; targetTypes: AuditOption[] };

// ---------- CSV ----------

export const AUDIT_EXPORT_FILE = "audit-log";

export const AUDIT_CSV_COLUMNS: readonly CsvColumn<AuditRow>[] = [
  { header: "When (IST)", value: (r) => formatAdminDateTimeLong(r.at) },
  { header: "Actor", value: (r) => r.actorName },
  { header: "Role", value: (r) => auditRoleLabel(r.actorRole) },
  { header: "Action", value: (r) => r.action },
  { header: "Target", value: (r) => r.target },
  { header: "Target type", value: (r) => (r.targetType ? targetTypeLabel(r.targetType) : "") },
  { header: "Target ID", value: (r) => r.targetId ?? "" },
  { header: "Reason", value: (r) => r.reason ?? "" },
  { header: "Detail", value: (r) => r.detail ?? "" },
  { header: "IP (masked)", value: (r) => (r.ipPrefix ? maskIp(r.ipPrefix) : "") },
  { header: "Event ID", value: (r) => r.id },
];

/** Audit detail of an audit export: the filters in words. */
export function auditExportDetail(query: { q: string; filters: Partial<Record<AuditFilterKey, string>> }): string | null {
  const f = query.filters;
  const parts = [
    f.role ? `role: ${auditRoleLabel(f.role)}` : null,
    f.actor ? `person: ${f.actor}` : null,
    f.action ? `action: ${f.action}` : null,
    f.targetType ? `target: ${f.targetType}` : null,
    f.from || f.to ? `dates: ${f.from ?? "\u2026"} to ${f.to ?? "\u2026"}` : null,
    query.q ? `search: ${query.q}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" \u00B7 ") : null;
}

// ---------- Copy (prototype; new strings are listed for owner review in the report) ----------

export const AUDIT_COPY = {
  caption: "Audit log",
  searchPlaceholder: "Search audit log",
  searchLabel: "Search the audit log",
  filters: { role: "Actor", actor: "Person", action: "Action", targetType: "Target", from: "From", to: "To" },
  all: "All",
  columns: { when: "When", actor: "Actor", action: "Action", target: "Target", detail: "Detail", ip: "IP" },
  drawerKind: "Audit event",
  fields: {
    actor: "Actor",
    role: "Role",
    target: "Target",
    targetType: "Target type",
    targetId: "Target ID",
    reason: "Reason",
    detail: "Detail",
    ip: "IP (masked)",
    id: "Event ID",
  },
  openTarget: "Open target",
  notFound: "This audit event doesn\u2019t exist.",
  loadFailed: "We couldn\u2019t load this audit event. Try again.",
  dateInvalid: "Pick a start date on or before the end date.",
  exported: (rows: number, file: string, truncated: boolean) =>
    `Exported ${rows.toLocaleString("en-IN")} ${rows === 1 ? "row" : "rows"} to ${file}${truncated ? " (first 10,000 rows)" : ""}`,
} as const;
