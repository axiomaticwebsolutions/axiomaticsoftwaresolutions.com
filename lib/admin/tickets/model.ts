/**
 * Staff support tickets (decisions.md Phase 6 "Tickets (staff)"; Admin Console.dc.html #tickets): the status and
 * priority vocabulary, the list state in the URL and the API list query, and the display helpers shared by the API
 * routes, the server page and the console. Request bodies live in ./schema.ts. Pure and client-safe.
 *
 *   /admin/tickets?q=scanner&filter[status]=open&filter[assignee]=me&sort=-updatedAt&page=2&id=T-3018
 */
import type { TicketPriority, TicketStatus } from "@/generated/prisma/enums";
import { parseListQuery, type ListQuerySpec } from "@/lib/admin/list-query";
import { defineListState, type ListState } from "@/lib/url-state";

/** RESOLVED tickets read as Closed this many days after resolution (same rule as the portal). */
export const TICKET_CLOSE_AFTER_DAYS = 14;
const DAY_MS = 86_400_000;

// ---------- Vocabulary ----------

/** Status keys as the console shows them ("closed" includes RESOLVED tickets past the 14-day window). */
export const ADMIN_TICKET_STATUSES = ["open", "awaiting_customer", "resolved", "closed"] as const;
export type AdminTicketStatus = (typeof ADMIN_TICKET_STATUSES)[number];

/** Priorities in display order (prototype: High, Normal, Low). */
export const ADMIN_TICKET_PRIORITIES = ["high", "normal", "low"] as const;
export type AdminTicketPriority = (typeof ADMIN_TICKET_PRIORITIES)[number];

export const STATUS_LABELS: Readonly<Record<AdminTicketStatus, string>> = {
  open: "Open",
  awaiting_customer: "Awaiting customer",
  resolved: "Resolved",
  closed: "Closed",
};

export const PRIORITY_LABELS: Readonly<Record<AdminTicketPriority, string>> = { high: "High", normal: "Normal", low: "Low" };

export const STATUS_TO_DB: Readonly<Record<AdminTicketStatus, TicketStatus>> = {
  open: "OPEN",
  awaiting_customer: "AWAITING_CUSTOMER",
  resolved: "RESOLVED",
  closed: "CLOSED",
};

export const PRIORITY_TO_DB: Readonly<Record<AdminTicketPriority, TicketPriority>> = { high: "HIGH", normal: "NORMAL", low: "LOW" };

const PRIORITY_FROM_DB: Readonly<Record<TicketPriority, AdminTicketPriority>> = { HIGH: "high", NORMAL: "normal", LOW: "low" };

export function priorityKey(priority: TicketPriority): AdminTicketPriority {
  return PRIORITY_FROM_DB[priority];
}

export function isAdminTicketStatus(value: string): value is AdminTicketStatus {
  return (ADMIN_TICKET_STATUSES as readonly string[]).includes(value);
}

export function isAdminTicketPriority(value: string): value is AdminTicketPriority {
  return (ADMIN_TICKET_PRIORITIES as readonly string[]).includes(value);
}

/** A RESOLVED ticket resolved at or before this moment reads as closed. */
export function closedCutoff(now: Date): Date {
  return new Date(now.getTime() - TICKET_CLOSE_AFTER_DAYS * DAY_MS);
}

/** Status as shown: RESOLVED turns into "closed" 14 days after resolvedAt (derived on read, like the portal). */
export function deriveAdminTicketStatus(ticket: { status: TicketStatus; resolvedAt: Date | null }, now: Date): AdminTicketStatus {
  if (ticket.status === "RESOLVED" && ticket.resolvedAt && ticket.resolvedAt.getTime() <= closedCutoff(now).getTime()) return "closed";
  switch (ticket.status) {
    case "OPEN":
      return "open";
    case "AWAITING_CUSTOMER":
      return "awaiting_customer";
    case "RESOLVED":
      return "resolved";
    default:
      return "closed";
  }
}

/** Open or waiting on the customer: still being handled (stats, bulk resolve). */
export function isActiveTicketStatus(status: AdminTicketStatus): boolean {
  return status === "open" || status === "awaiting_customer";
}

// ---------- List state (page URL) and list query (API) ----------

export const ADMIN_TICKET_SORTS = ["id", "priority", "status", "updatedAt", "createdAt"] as const;
export type AdminTicketSort = (typeof ADMIN_TICKET_SORTS)[number];
export const ADMIN_TICKETS_PAGE_SIZE = 25;

/** Staff user ids (cuid or seed ids), "me" and "none" (unassigned). */
export const ASSIGNEE_FILTER_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Product ids ("medical-billing"). */
export const PRODUCT_FILTER_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export type AdminTicketFilterKey = "status" | "priority" | "assignee" | "product";

/** The console's list state: `?q=&filter[status]=&filter[priority]=&filter[assignee]=&filter[product]=&sort=&page=`. */
export const ADMIN_TICKETS_LIST = defineListState<AdminTicketFilterKey>({
  filters: {
    status: { values: ADMIN_TICKET_STATUSES },
    priority: { values: ADMIN_TICKET_PRIORITIES },
    assignee: {},
    product: {},
  },
  sortable: ["id", "priority", "status", "updatedAt"],
  defaultSort: { id: "updatedAt", desc: true },
  pageSize: ADMIN_TICKETS_PAGE_SIZE,
  filterStyle: "bracket",
});

export type AdminTicketsListState = ListState<AdminTicketFilterKey>;

/** What the list service takes (from the page URL or the API query string). */
export type AdminTicketQuery = {
  q: string;
  status?: AdminTicketStatus;
  priority?: AdminTicketPriority;
  /** "me", "none" (unassigned) or a staff user id. */
  assignee?: string;
  product?: string;
  sort: { id: AdminTicketSort; desc: boolean };
  page: number;
  pageSize: number;
};

function isSort(value: string): value is AdminTicketSort {
  return (ADMIN_TICKET_SORTS as readonly string[]).includes(value);
}

const ADMIN_TICKET_LIST_SPEC: ListQuerySpec<
  { status: readonly string[]; priority: readonly string[]; assignee: (raw: string) => string | undefined; product: (raw: string) => string | undefined },
  AdminTicketSort
> = {
  filters: {
    status: ADMIN_TICKET_STATUSES,
    priority: ADMIN_TICKET_PRIORITIES,
    assignee: (raw) => (ASSIGNEE_FILTER_RE.test(raw) ? raw : undefined),
    product: (raw) => (PRODUCT_FILTER_RE.test(raw) ? raw : undefined),
  },
  sortable: ADMIN_TICKET_SORTS,
  defaultSort: "-updatedAt",
  defaultPageSize: ADMIN_TICKETS_PAGE_SIZE,
};

/** Parses GET /api/admin/tickets (and export.csv) query strings, leniently like every admin list. */
export function parseAdminTicketQuery(input: Request | URL | URLSearchParams | string): AdminTicketQuery {
  const parsed = parseListQuery(input, ADMIN_TICKET_LIST_SPEC);
  const { status, priority, assignee, product } = parsed.filters;
  return {
    q: parsed.q,
    ...(status && isAdminTicketStatus(status) ? { status } : {}),
    ...(priority && isAdminTicketPriority(priority) ? { priority } : {}),
    ...(assignee ? { assignee } : {}),
    ...(product ? { product } : {}),
    sort: parsed.sort,
    page: parsed.page,
    pageSize: parsed.pageSize,
  };
}

/** The service query for the page's parsed URL state (unknown values fall back to the defaults). */
export function ticketQueryFromListState(state: AdminTicketsListState): AdminTicketQuery {
  const { status, priority, assignee, product } = state.filters;
  const sort = state.sort && isSort(state.sort.id) ? { id: state.sort.id, desc: state.sort.desc } : { id: "updatedAt" as const, desc: true };
  return {
    q: state.q,
    ...(isAdminTicketStatus(status) ? { status } : {}),
    ...(isAdminTicketPriority(priority) ? { priority } : {}),
    ...(assignee && assignee !== "all" && ASSIGNEE_FILTER_RE.test(assignee) ? { assignee } : {}),
    ...(product && product !== "all" && PRODUCT_FILTER_RE.test(product) ? { product } : {}),
    sort,
    page: state.page,
    pageSize: state.pageSize,
  };
}

// ---------- Display ----------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const IST_OFFSET_MS = 330 * 60_000;

/** "7 Oct, 1:40 pm" (prototype fdt; IST, 12-hour clock). */
export function formatTicketTime(at: Date | string | null | undefined): string {
  if (!at) return "\u2014";
  const d = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  const hour = d.getUTCHours();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const minute = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${hour12}:${minute} ${hour < 12 ? "am" : "pm"}`;
}

/** "7 Oct 2026, 1:40 pm": the full form for tooltips. */
export function formatTicketDateTime(at: Date | string | null | undefined): string {
  if (!at) return "\u2014";
  const d = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  const year = d.getUTCFullYear();
  const short = formatTicketTime(at);
  const comma = short.indexOf(",");
  return `${short.slice(0, comma)} ${year}${short.slice(comma)}`;
}

/** Prototype rel(): "just now", "29m ago", "10h ago", "3d ago", else the IST date ("17 Nov 2026"). */
export function relativeTicketTime(at: Date | string, now: Date): string {
  const then = new Date(at);
  const minutes = (now.getTime() - then.getTime()) / 60_000;
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  const days = Math.round(minutes / 1440);
  if (days < 30) return `${days}d ago`;
  const d = new Date(then.getTime() + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** A response time: "under 1m", "45m", "2h 14m", "3h", "1d 4h", "6d". */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "\u2014";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** First-reply target shown in the drawer (prototype; the settings have no field for it yet). */
export const FIRST_REPLY_TARGET = "1 business day";
/** Days the "First response" stat looks back over. */
export const FIRST_RESPONSE_WINDOW_DAYS = 30;

/** Drawer "First response": the time to the first public staff reply, or that none was sent yet. */
export function firstResponseLabel(ticket: { createdAt: string; firstResponseAt: string | null }): string {
  if (!ticket.firstResponseAt) return `Not yet \u00B7 target ${FIRST_REPLY_TARGET}`;
  return formatDuration(Date.parse(ticket.firstResponseAt) - Date.parse(ticket.createdAt));
}

/** "Sneha Patil" -> "Sneha". */
export function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** "2 attachments" / "1 attachment". */
export function attachmentCount(n: number): string {
  return `${n} ${n === 1 ? "attachment" : "attachments"}`;
}

/** Staff an assignee filter or select lists: active staff whose role handles tickets. */
export type TicketAssigneeOption = { id: string; name: string; role: string };
export type TicketProductOption = { id: string; name: string };

/** "Assign to me" / "Mark resolved" (prototype bulk bar). */
export const TICKET_BULK_ACTIONS = ["assign_to_me", "resolve"] as const;
export type TicketBulkAction = (typeof TICKET_BULK_ACTIONS)[number];
