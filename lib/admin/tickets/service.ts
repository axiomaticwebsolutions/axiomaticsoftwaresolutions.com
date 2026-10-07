/**
 * Support tickets for staff (decisions.md Phase 6 "Tickets (staff)"; api-contracts section 7 `tickets`; Admin
 * Console.dc.html #tickets). Staff see every account's tickets with the whole conversation, including internal notes.
 *
 * - Lists filter by status (derived: RESOLVED reads as Closed 14 days after resolution, like the portal), priority,
 *   assignee ("me", "none" or a staff id) and product, search id, subject, business and customer, and sort by
 *   ticket (opening order), priority (High first when ascending, as in the prototype), status or last update.
 * - A public staff reply (TicketMessage isStaff, not internal) sets firstResponseAt once, moves the ticket to
 *   AWAITING_CUSTOMER (reopening a resolved or closed one), assigns it to the replier when nobody has it (prototype),
 *   notifies the opener (in-app Notification + ticket_reply email through the outbox, unless they turned ticket
 *   emails off) and is audited "Replied to ticket". An internal note changes nothing on the ticket, notifies nobody
 *   and is audited "Added internal note". Notes never reach customers: the portal reads only internal = false.
 * - Status, priority and assignee changes (PATCH, bulk) write one audit row per change in the same transaction.
 * - Attachments are Upload rows of the ticket's account uploaded by the staff member (lib/admin/tickets/uploads.ts),
 *   so customers can download the ones on public replies through the portal.
 * Server-only; routes check `tickets.manage` first.
 */
import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { pageResult, type ListPage } from "@/lib/admin/list-query";
import { audit, type AuditActor } from "@/lib/audit";
import { db as defaultDb, type Db, type Tx } from "@/lib/db";
import { enqueueEmail, kickEmailDispatch } from "@/lib/email";
import { greetingName } from "@/lib/email/greeting";
import { getEnv } from "@/lib/env";
import { errors } from "@/lib/http";
import { redactLicenseKeys } from "@/lib/licensing/keys";
import { log } from "@/lib/log";
import { recordAccountActivity } from "@/lib/portal/activity";
import { readStoredEmailPrefs } from "@/lib/portal/preferences";
import { attachmentsJson, attachmentViews, attachUploads, verifyAttachableUploads, type AttachmentView } from "@/lib/portal/uploads";
import { PERMS, STAFF_ROLE_LABELS } from "@/lib/rbac";
import type { StorageDriver } from "@/lib/storage";
import {
  attachmentCount,
  closedCutoff,
  deriveAdminTicketStatus,
  firstNameOf,
  FIRST_RESPONSE_WINDOW_DAYS,
  isActiveTicketStatus,
  PRIORITY_LABELS,
  PRIORITY_TO_DB,
  priorityKey,
  STATUS_LABELS,
  STATUS_TO_DB,
  type AdminTicketPriority,
  type AdminTicketQuery,
  type AdminTicketStatus,
  type TicketAssigneeOption,
  type TicketProductOption,
} from "./model";
import { FIRST_RESPONSE_AT_SQL, FIRST_STAFF_REPLY_SELECT, firstResponseOf } from "./first-response";
import { ADMIN_TICKET_ERRORS, type StaffMessageInput, type TicketBulkInput, type TicketPatchInput } from "./schema";

/** Messages returned with one ticket (the newest are kept). */
export const ADMIN_TICKET_MESSAGES_LIMIT = 500;
/** Roles that handle tickets: the assignee choices. */
const TICKET_ROLES = PERMS["tickets.manage"];

export type StaffActor = { id: string; name: string };

// ---------- Shapes ----------

export type AdminTicketRow = {
  id: string;
  subject: string;
  status: AdminTicketStatus;
  priority: AdminTicketPriority;
  product: { id: string; name: string; shortName: string } | null;
  licenseId: string | null;
  account: { id: string; name: string };
  /** Who opened it (older tickets: the author of the first customer message). */
  customer: { name: string; email: string } | null;
  assignee: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
  firstResponseAt: string | null;
};

export type AdminTicketMessage = {
  id: string;
  author: { id: string; name: string; email: string; isStaff: boolean };
  /** Staff-only note: never shown or sent to the customer. */
  internal: boolean;
  body: string;
  createdAt: string;
  attachments: AttachmentView[];
};

export type AdminTicketDetail = {
  ticket: AdminTicketRow & { resolvedAt: string | null; closedAt: string | null; accountGstin: string | null };
  /** Oldest first, internal notes included. */
  messages: AdminTicketMessage[];
};

export type AdminTicketStats = {
  open: number;
  awaitingCustomer: number;
  /** Open or awaiting customer, nobody assigned. */
  unassigned: number;
  /** Open or awaiting customer, High priority. */
  highPriority: number;
  /** Median time to the first public staff reply of tickets opened in the last 30 days (null without replies). */
  firstResponseMedianMs: number | null;
  firstResponseSample: number;
};

const ROW_SELECT = {
  id: true,
  subject: true,
  status: true,
  priority: true,
  productId: true,
  licenseId: true,
  resolvedAt: true,
  closedAt: true,
  firstResponseAt: true,
  createdAt: true,
  updatedAt: true,
  account: { select: { id: true, legalName: true, gstin: true } },
  openedBy: { select: { name: true, email: true } },
  assignee: { select: { id: true, name: true } },
} as const satisfies Prisma.SupportTicketSelect;

type TicketRecord = Prisma.SupportTicketGetPayload<{ select: typeof ROW_SELECT }>;
type ProductNames = Map<string, { name: string; shortName: string }>;
type Person = { name: string; email: string };

async function productNames(client: Db, ids: Iterable<string | null>): Promise<ProductNames> {
  const unique = [...new Set([...ids].filter((v): v is string => typeof v === "string"))];
  if (unique.length === 0) return new Map();
  const rows = await client.product.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, shortName: true } });
  return new Map(rows.map((r) => [r.id, { name: r.name, shortName: r.shortName }]));
}

/** Openers of tickets without openedById (sample and older tickets): the author of the first customer message. */
async function firstCustomerAuthors(client: Db, ticketIds: string[]): Promise<Map<string, Person & { id: string }>> {
  if (ticketIds.length === 0) return new Map();
  const rows = await client.ticketMessage.findMany({
    where: { ticketId: { in: ticketIds }, isStaff: false, internal: false },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    distinct: ["ticketId"],
    select: { ticketId: true, author: { select: { id: true, name: true, email: true } } },
  });
  return new Map(rows.map((r) => [r.ticketId, r.author]));
}

function toRow(record: TicketRecord, products: ProductNames, opener: Person | undefined, now: Date): AdminTicketRow {
  const product = record.productId ? products.get(record.productId) : undefined;
  const customer = record.openedBy ?? opener;
  return {
    id: record.id,
    subject: record.subject,
    status: deriveAdminTicketStatus(record, now),
    priority: priorityKey(record.priority),
    product: record.productId && product ? { id: record.productId, ...product } : null,
    licenseId: record.licenseId,
    account: { id: record.account.id, name: record.account.legalName },
    customer: customer ? { name: customer.name, email: customer.email } : null,
    assignee: record.assignee ? { id: record.assignee.id, name: record.assignee.name } : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    firstResponseAt: record.firstResponseAt?.toISOString() ?? null,
  };
}

async function toRows(client: Db, records: TicketRecord[], now: Date): Promise<AdminTicketRow[]> {
  const [products, openers] = await Promise.all([
    productNames(client, records.map((r) => r.productId)),
    firstCustomerAuthors(client, records.filter((r) => !r.openedBy).map((r) => r.id)),
  ]);
  return records.map((r) => toRow(r, products, openers.get(r.id), now));
}

// ---------- Lists ----------

/** Where clause of one status as shown (RESOLVED splits into resolved and closed at the 14-day mark). */
export function ticketStatusWhere(status: AdminTicketStatus, now: Date): Prisma.SupportTicketWhereInput {
  const cutoff = closedCutoff(now);
  switch (status) {
    case "resolved":
      return { status: "RESOLVED", OR: [{ resolvedAt: null }, { resolvedAt: { gt: cutoff } }] };
    case "closed":
      return { OR: [{ status: "CLOSED" }, { status: "RESOLVED", resolvedAt: { lte: cutoff } }] };
    default:
      return { status: STATUS_TO_DB[status] };
  }
}

/** The list's filters and search for the signed-in staff member ("me"). */
export function ticketListWhere(query: AdminTicketQuery, staffId: string, now: Date): Prisma.SupportTicketWhereInput {
  const and: Prisma.SupportTicketWhereInput[] = [];
  if (query.status) and.push(ticketStatusWhere(query.status, now));
  if (query.priority) and.push({ priority: PRIORITY_TO_DB[query.priority] });
  if (query.assignee === "me") and.push({ assigneeId: staffId });
  else if (query.assignee === "none") and.push({ assigneeId: null });
  else if (query.assignee) and.push({ assigneeId: query.assignee });
  if (query.product) and.push({ productId: query.product });
  const q = query.q.trim();
  if (q) {
    const contains = { contains: q, mode: "insensitive" as const };
    and.push({
      OR: [
        { id: contains },
        { subject: contains },
        { account: { legalName: contains } },
        { openedBy: { OR: [{ email: contains }, { name: contains }] } },
        { messages: { some: { isStaff: false, internal: false, author: { OR: [{ email: contains }, { name: contains }] } } } },
      ],
    });
  }
  return and.length > 0 ? { AND: and } : {};
}

/** Sort for the list. Ticket ids grow with time, so "id" sorts by opening time (numeric order, not "T-999" > "T-1000"). */
export function ticketOrderBy(sort: AdminTicketQuery["sort"]): Prisma.SupportTicketOrderByWithRelationInput[] {
  const dir = sort.desc ? "desc" : "asc";
  switch (sort.id) {
    case "id":
    case "createdAt":
      return [{ createdAt: dir }, { id: dir }];
    case "priority":
      // Ascending is High first (prototype sortVal High 0, Normal 1, Low 2); the enum is declared LOW, NORMAL, HIGH.
      return [{ priority: sort.desc ? "asc" : "desc" }, { updatedAt: "desc" }, { id: "desc" }];
    case "status":
      return [{ status: dir }, { updatedAt: "desc" }, { id: "desc" }];
    default:
      return [{ updatedAt: dir }, { id: dir }];
  }
}

/** One page of tickets: `{ items, total, page, pageSize }`. */
export async function listAdminTickets(
  input: { query: AdminTicketQuery; staffId: string; now?: Date },
  client: Db = defaultDb,
): Promise<ListPage<AdminTicketRow>> {
  const now = input.now ?? new Date();
  const { query } = input;
  const where = ticketListWhere(query, input.staffId, now);
  const [total, records] = await Promise.all([
    client.supportTicket.count({ where }),
    client.supportTicket.findMany({
      where,
      orderBy: ticketOrderBy(query.sort),
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: ROW_SELECT,
    }),
  ]);
  return pageResult(await toRows(client, records, now), total, query);
}

// ---------- Stats and filter options ----------

/**
 * Stats row: open, awaiting customer, unassigned and high priority (of open + awaiting tickets, one counting query)
 * and the median first response of the last 30 days (a second query). Two queries keep the page light on the pool.
 */
export async function ticketStats(client: Db = defaultDb, now: Date = new Date()): Promise<AdminTicketStats> {
  const since = new Date(now.getTime() - FIRST_RESPONSE_WINDOW_DAYS * 86_400_000);
  const [counts, median] = await Promise.all([
    client.$queryRaw<{ open: number; awaiting: number; unassigned: number; high: number }[]>`
      SELECT count(*) FILTER (WHERE t."status" = 'OPEN')::int AS "open",
             count(*) FILTER (WHERE t."status" = 'AWAITING_CUSTOMER')::int AS "awaiting",
             count(*) FILTER (WHERE t."assigneeId" IS NULL)::int AS "unassigned",
             count(*) FILTER (WHERE t."priority" = 'HIGH')::int AS "high"
      FROM "SupportTicket" t
      WHERE t."status" IN ('OPEN', 'AWAITING_CUSTOMER')`,
    // firstResponseAt, or for tickets answered before it was recorded, the first public staff message (shared with Reports).
    client.$queryRaw<{ median: number | null; n: number }[]>`
      SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY GREATEST(0, r.ms)) AS "median", count(*)::int AS "n"
      FROM (
        SELECT (EXTRACT(EPOCH FROM (${FIRST_RESPONSE_AT_SQL} - t."createdAt")) * 1000)::float8 AS ms
        FROM "SupportTicket" t
        WHERE t."createdAt" >= ${since}::timestamp(3) AND t."createdAt" < ${now}::timestamp(3)
      ) r
      WHERE r.ms IS NOT NULL`,
  ]);
  const row = median[0];
  const sample = Number(row?.n ?? 0);
  const c = counts[0];
  return {
    open: Number(c?.open ?? 0),
    awaitingCustomer: Number(c?.awaiting ?? 0),
    unassigned: Number(c?.unassigned ?? 0),
    highPriority: Number(c?.high ?? 0),
    firstResponseMedianMs: sample > 0 && row?.median !== null && row?.median !== undefined ? Number(row.median) : null,
    firstResponseSample: sample,
  };
}

/** Active staff whose role handles tickets (assignee filter and select), by name. */
export async function ticketAssignees(client: Db = defaultDb): Promise<TicketAssigneeOption[]> {
  const rows = await client.user.findMany({
    where: { kind: "STAFF", staffStatus: "ACTIVE", staffRole: { in: [...TICKET_ROLES] } },
    orderBy: [{ name: "asc" }, { id: "asc" }],
    select: { id: true, name: true, email: true, staffRole: true },
  });
  return rows.map((r) => ({ id: r.id, name: r.name.trim() || r.email, role: r.staffRole ? STAFF_ROLE_LABELS[r.staffRole] : "" }));
}

/** Products for the Product filter (every product, by name; labelled with the short name, as in the tables). */
export async function ticketProducts(client: Db = defaultDb): Promise<TicketProductOption[]> {
  const rows = await client.product.findMany({ orderBy: [{ name: "asc" }, { id: "asc" }], select: { id: true, name: true, shortName: true } });
  return rows.map((p) => ({ id: p.id, name: p.shortName.trim() || p.name }));
}

// ---------- Detail ----------

/** One ticket with every message (internal notes included), oldest first. 404 for an unknown id. */
export async function getAdminTicket(input: { ticketId: string; now?: Date }, client: Db = defaultDb): Promise<AdminTicketDetail> {
  const now = input.now ?? new Date();
  const record = await client.supportTicket.findUnique({ where: { id: input.ticketId }, select: ROW_SELECT });
  if (!record) throw errors.notFound("Ticket");
  const newest = await client.ticketMessage.findMany({
    where: { ticketId: record.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: ADMIN_TICKET_MESSAGES_LIMIT,
    select: {
      id: true,
      isStaff: true,
      internal: true,
      body: true,
      attachments: true,
      createdAt: true,
      author: { select: { id: true, name: true, email: true } },
    },
  });
  const messages = newest.reverse();
  const products = await productNames(client, [record.productId]);
  const firstCustomer = record.openedBy ? undefined : messages.find((m) => !m.isStaff && !m.internal)?.author;
  const row = toRow(record, products, firstCustomer, now);
  // Tickets answered before firstResponseAt was recorded: the first public staff message (even beyond the loaded page).
  const firstStaffReply = record.firstResponseAt
    ? []
    : await client.ticketMessage.findMany({ ...FIRST_STAFF_REPLY_SELECT, where: { ticketId: record.id, ...FIRST_STAFF_REPLY_SELECT.where } });
  const firstResponse = firstResponseOf({ firstResponseAt: record.firstResponseAt, messages: firstStaffReply });
  return {
    ticket: {
      ...row,
      firstResponseAt: firstResponse?.toISOString() ?? null,
      resolvedAt: record.resolvedAt?.toISOString() ?? null,
      closedAt: record.closedAt?.toISOString() ?? null,
      accountGstin: record.account.gstin,
    },
    messages: messages.map((m) => ({
      id: m.id,
      author: { id: m.author.id, name: m.author.name.trim() || m.author.email, email: m.author.email, isStaff: m.isStaff },
      internal: m.internal,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      attachments: attachmentViews(m.attachments),
    })),
  };
}

/** Locks the ticket row for the rest of the transaction; 404 when it does not exist. */
async function lockTicket(tx: Tx, ticketId: string) {
  await tx.$queryRaw`SELECT "id" FROM "SupportTicket" WHERE "id" = ${ticketId} FOR UPDATE`;
  const ticket = await tx.supportTicket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      accountId: true,
      subject: true,
      status: true,
      priority: true,
      resolvedAt: true,
      firstResponseAt: true,
      openedById: true,
      assigneeId: true,
      assignee: { select: { name: true } },
    },
  });
  if (!ticket) throw errors.notFound("Ticket");
  return ticket;
}

// ---------- Status, priority and assignee ----------

type StatusUpdate = {
  data: Prisma.SupportTicketUpdateManyMutationInput;
  action: string;
  detail: string;
  /** Entry for the customer's activity log (resolving, closing and reopening are visible to them). */
  activity: string | null;
};

/** The update and audit entry for moving a ticket from `from` to `to` (as shown). */
function statusUpdate(from: AdminTicketStatus, to: AdminTicketStatus, resolvedAt: Date | null, now: Date): StatusUpdate {
  const detail = `${STATUS_LABELS[from]} \u2192 ${STATUS_LABELS[to]}`;
  switch (to) {
    case "resolved":
      return { data: { status: "RESOLVED", resolvedAt: now, closedAt: null }, action: "Resolved ticket", detail, activity: "Resolved ticket" };
    case "closed":
      return { data: { status: "CLOSED", closedAt: now, resolvedAt: resolvedAt ?? now }, action: "Closed ticket", detail, activity: "Closed ticket" };
    default:
      return {
        data: { status: STATUS_TO_DB[to], resolvedAt: null, closedAt: null },
        action: isActiveTicketStatus(from) ? "Changed ticket status" : "Reopened ticket",
        detail,
        activity: isActiveTicketStatus(from) ? null : "Reopened ticket",
      };
  }
}

/** An active staff member whose role handles tickets, else 422 on `assigneeId`. */
async function ticketAssignee(tx: Tx, userId: string): Promise<{ id: string; name: string }> {
  const user = await tx.user.findFirst({
    where: { id: userId, kind: "STAFF", staffStatus: "ACTIVE", staffRole: { in: [...TICKET_ROLES] } },
    select: { id: true, name: true, email: true },
  });
  if (!user) throw errors.validation({ assigneeId: ADMIN_TICKET_ERRORS.assignee });
  return { id: user.id, name: user.name.trim() || user.email };
}

function ticketAudit(ticketId: string, action: string, detail?: string | null) {
  return { action, target: ticketId, targetType: "ticket", targetId: ticketId, detail: detail ?? null };
}

/** How staff appear in a customer's activity log: "Sneha (Axiomatic Support)" (seeded entries use the same form). */
export function staffActivityName(name: string): string {
  const first = firstNameOf(name);
  return first ? `${first} (Axiomatic Support)` : "Axiomatic Support";
}

async function customerActivity(tx: Tx, ticket: { id: string; accountId: string }, staff: StaffActor, action: string, now: Date) {
  await recordAccountActivity(tx, {
    accountId: ticket.accountId,
    actor: { id: null, name: staffActivityName(staff.name) },
    action,
    target: ticket.id,
    kind: "ticket",
    at: now,
  });
}

export type TicketChange = "status" | "priority" | "assignee";

/**
 * PATCH: status, priority and/or assignee. Each actual change is written with one audit row ("Resolved ticket",
 * "Reopened ticket", "Closed ticket", "Changed ticket status", "Changed ticket priority", "Assigned ticket",
 * "Unassigned ticket"), all in one transaction; a value equal to the current one changes nothing.
 */
export async function updateAdminTicket(
  input: { ticketId: string; patch: TicketPatchInput; staff: StaffActor; actor: AuditActor; now?: Date },
  client: PrismaClient = defaultDb,
): Promise<{ detail: AdminTicketDetail; changed: TicketChange[] }> {
  const now = input.now ?? new Date();
  const { patch } = input;
  const changed = await client.$transaction(async (tx) => {
    const ticket = await lockTicket(tx, input.ticketId);
    const data: Prisma.SupportTicketUpdateManyMutationInput & { assigneeId?: string | null } = {};
    const entries: ReturnType<typeof ticketAudit>[] = [];
    const done: TicketChange[] = [];
    let activity: string | null = null;

    const current = deriveAdminTicketStatus(ticket, now);
    if (patch.status !== undefined && patch.status !== current) {
      const update = statusUpdate(current, patch.status, ticket.resolvedAt, now);
      Object.assign(data, update.data);
      entries.push(ticketAudit(ticket.id, update.action, update.detail));
      activity = update.activity;
      done.push("status");
    }
    if (patch.priority !== undefined && PRIORITY_TO_DB[patch.priority] !== ticket.priority) {
      data.priority = PRIORITY_TO_DB[patch.priority];
      entries.push(ticketAudit(ticket.id, "Changed ticket priority", `${PRIORITY_LABELS[priorityKey(ticket.priority)]} \u2192 ${PRIORITY_LABELS[patch.priority]}`));
      done.push("priority");
    }
    if (patch.assigneeId !== undefined && patch.assigneeId !== ticket.assigneeId) {
      if (patch.assigneeId === null) {
        data.assigneeId = null;
        entries.push(ticketAudit(ticket.id, "Unassigned ticket", ticket.assignee ? `from ${ticket.assignee.name}` : null));
      } else {
        const assignee = await ticketAssignee(tx, patch.assigneeId);
        data.assigneeId = assignee.id;
        entries.push(ticketAudit(ticket.id, "Assigned ticket", `to ${assignee.name}`));
      }
      done.push("assignee");
    }
    if (done.length === 0) return done;
    await tx.supportTicket.updateMany({ where: { id: ticket.id }, data: { ...data, updatedAt: now } });
    for (const entry of entries) await audit(tx, input.actor, entry);
    if (activity) await customerActivity(tx, ticket, input.staff, activity, now);
    return done;
  });
  if (changed.length > 0) log.info("admin_ticket_updated", { ticketId: input.ticketId, changed });
  return { detail: await getAdminTicket({ ticketId: input.ticketId, now }, client), changed };
}

export type TicketBulkResult = { updated: string[]; unchanged: string[]; missing: string[] };

/**
 * Bulk bar: "Assign to me" (tickets someone else or nobody has) and "Mark resolved" (open or awaiting customer).
 * One transaction; one audit row per ticket changed. Unknown ids are reported, not an error.
 */
export async function bulkUpdateTickets(
  input: { data: TicketBulkInput; staff: StaffActor; actor: AuditActor; now?: Date },
  client: PrismaClient = defaultDb,
): Promise<TicketBulkResult> {
  const now = input.now ?? new Date();
  const ids = [...input.data.ids].sort();
  const result = await client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "SupportTicket" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
    const rows = await tx.supportTicket.findMany({
      where: { id: { in: ids } },
      select: { id: true, accountId: true, status: true, resolvedAt: true, assigneeId: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: TicketBulkResult = { updated: [], unchanged: [], missing: [] };
    const me = input.data.action === "assign_to_me" ? await ticketAssignee(tx, input.staff.id) : null;
    for (const id of input.data.ids) {
      const row = byId.get(id);
      if (!row) {
        out.missing.push(id);
        continue;
      }
      if (me) {
        if (row.assigneeId === me.id) {
          out.unchanged.push(id);
          continue;
        }
        await tx.supportTicket.updateMany({ where: { id }, data: { assigneeId: me.id, updatedAt: now } });
        await audit(tx, input.actor, ticketAudit(id, "Assigned ticket", `to ${me.name}`));
      } else {
        const current = deriveAdminTicketStatus(row, now);
        if (!isActiveTicketStatus(current)) {
          out.unchanged.push(id);
          continue;
        }
        const update = statusUpdate(current, "resolved", row.resolvedAt, now);
        await tx.supportTicket.updateMany({ where: { id }, data: { ...update.data, updatedAt: now } });
        await audit(tx, input.actor, ticketAudit(id, update.action, update.detail));
        if (update.activity) await customerActivity(tx, row, input.staff, update.activity, now);
      }
      out.updated.push(id);
    }
    return out;
  });
  log.info("admin_tickets_bulk", { action: input.data.action, updated: result.updated.length, unchanged: result.unchanged.length });
  return result;
}

// ---------- Replies and internal notes ----------

/** Portal path of a ticket (notification link; the email gets the absolute URL). */
export function portalTicketPath(ticketId: string): string {
  return `/account/tickets/${encodeURIComponent(ticketId)}`;
}

type Recipient = { id: string; name: string; email: string; notificationPrefs: unknown };

/**
 * Who hears about a staff reply: the opener (older tickets: the author of the first customer message), only while
 * they are a customer and an active member of the ticket's account. Anyone else gets nothing.
 */
async function replyRecipient(tx: Tx, ticket: { id: string; accountId: string; openedById: string | null }): Promise<Recipient | null> {
  let userId = ticket.openedById;
  if (!userId) {
    const first = await tx.ticketMessage.findFirst({
      where: { ticketId: ticket.id, isStaff: false, internal: false },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { authorId: true },
    });
    userId = first?.authorId ?? null;
  }
  if (!userId) return null;
  const user = await tx.user.findFirst({
    where: { id: userId, kind: "CUSTOMER", memberships: { some: { accountId: ticket.accountId, status: "ACTIVE" } } },
    select: { id: true, name: true, email: true, notificationPrefs: true },
  });
  return user;
}

export type StaffMessageResult = {
  detail: AdminTicketDetail;
  messageId: string;
  /** The opener got an in-app notification (public replies only). */
  notified: boolean;
  /** A ticket_reply email was queued (the opener keeps ticket emails on). */
  emailed: boolean;
};

/**
 * POST /api/admin/tickets/:id/messages. Attachments are this staff member's own pending uploads in the ticket's
 * account (checked in storage first, then attached inside the transaction; 422 / 409 otherwise).
 * - Internal note: a TicketMessage with internal = true. Nothing else changes (not even updatedAt, which customers
 *   see); no notification, no email, no customer activity. Audited "Added internal note".
 * - Public reply: status AWAITING_CUSTOMER (reopening a resolved or closed ticket), firstResponseAt set once,
 *   assigned to the replier when nobody has it, the opener notified in the portal and, unless they turned ticket
 *   emails off, emailed ticket_reply through the outbox (dispatched after the commit). Audited "Replied to ticket"
 *   and logged in the customer's activity as "{First name} (Axiomatic Support)".
 * A full license key typed into the message is stored masked, as in the portal.
 */
export async function addStaffMessage(
  input: { ticketId: string; data: StaffMessageInput; staff: StaffActor; actor: AuditActor; now?: Date },
  client: PrismaClient = defaultDb,
  storage?: StorageDriver,
): Promise<StaffMessageResult> {
  const now = input.now ?? new Date();
  const { data, staff } = input;
  const head = await client.supportTicket.findUnique({ where: { id: input.ticketId }, select: { id: true, accountId: true } });
  if (!head) throw errors.notFound("Ticket");
  const uploads = await verifyAttachableUploads({ accountId: head.accountId, userId: staff.id, ids: data.attachmentIds, now }, client, storage);
  const body = redactLicenseKeys(data.body);
  const files = uploads.length > 0 ? attachmentCount(uploads.length) : null;

  const outcome = await client.$transaction(async (tx) => {
    const ticket = await lockTicket(tx, head.id);
    const message = await tx.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: staff.id,
        isStaff: true,
        internal: data.internal,
        body,
        attachments: attachmentsJson(uploads),
        createdAt: now,
      },
      select: { id: true },
    });
    await attachUploads(tx, { accountId: ticket.accountId, userId: staff.id, ids: data.attachmentIds, ticketMessageId: message.id, now });

    if (data.internal) {
      await audit(tx, input.actor, ticketAudit(ticket.id, "Added internal note", files));
      return { messageId: message.id, notified: false, emailed: false };
    }

    const current = deriveAdminTicketStatus(ticket, now);
    const firstResponse = ticket.firstResponseAt === null;
    const autoAssign = ticket.assigneeId === null;
    await tx.supportTicket.updateMany({
      where: { id: ticket.id },
      data: {
        status: "AWAITING_CUSTOMER",
        resolvedAt: null,
        closedAt: null,
        ...(firstResponse ? { firstResponseAt: now } : {}),
        ...(autoAssign ? { assigneeId: staff.id } : {}),
        updatedAt: now,
      },
    });
    const detail = [
      current === "awaiting_customer" ? null : `${STATUS_LABELS[current]} \u2192 ${STATUS_LABELS.awaiting_customer}`,
      firstResponse ? "first response" : null,
      autoAssign ? `assigned to ${staff.name}` : null,
      files,
    ].filter((part): part is string => part !== null);
    await audit(tx, input.actor, ticketAudit(ticket.id, "Replied to ticket", detail.join(" \u00B7 ") || null));
    await customerActivity(tx, ticket, staff, "Replied to ticket", now);

    const recipient = await replyRecipient(tx, ticket);
    if (!recipient) return { messageId: message.id, notified: false, emailed: false };
    const first = firstNameOf(staff.name) || "Axiomatic Support";
    await tx.notification.create({
      data: {
        userId: recipient.id,
        kind: "ticket",
        title: `Support replied to ${ticket.id}`,
        body: `${first} replied to \u201C${ticket.subject}\u201D.`,
        href: portalTicketPath(ticket.id),
        createdAt: now,
      },
    });
    if (!readStoredEmailPrefs(recipient.notificationPrefs).tickets) return { messageId: message.id, notified: true, emailed: false };
    await enqueueEmail(tx, {
      to: recipient.email,
      templateId: "ticket_reply",
      vars: {
        customer_name: greetingName(recipient.name),
        ticket_id: ticket.id,
        ticket_url: `${getEnv().APP_URL}${portalTicketPath(ticket.id)}`,
      },
      dedupeKey: `ticket_reply:${message.id}`,
    });
    return { messageId: message.id, notified: true, emailed: true };
  });

  if (outcome.emailed) kickEmailDispatch();
  log.info(data.internal ? "admin_ticket_note" : "admin_ticket_reply", {
    ticketId: head.id,
    attachments: uploads.length,
    notified: outcome.notified,
  });
  return { ...outcome, detail: await getAdminTicket({ ticketId: head.id, now }, client) };
}
