/**
 * Customer support tickets (portal "Support tickets", "New support ticket", "Ticket detail"; docs/decisions.md Phase
 * 5 "Tickets"; api-contracts section 5).
 *
 * - Everything is scoped to the caller's active business account: another account's ticket reads like an unknown id
 *   (404). Every member with `tickets.view` (all roles, Viewer included) can read; creating, replying, resolving and
 *   reopening need `tickets.create` (Owner, Billing admin, Technical contact). Routes check the permission first.
 * - Staff-only notes (TicketMessage.internal) are never returned.
 * - Statuses: OPEN "Waiting for support", AWAITING_CUSTOMER "Waiting for you", RESOLVED, CLOSED. A customer reply moves
 *   AWAITING_CUSTOMER back to OPEN; customers may resolve open tickets and reopen RESOLVED ones; CLOSED tickets (closed by
 *   staff, or resolved more than TICKET_AUTO_CLOSE_DAYS ago, derived at read time until a job stores it) cannot be
 *   reopened or answered: start a new ticket.
 * - Ticket ids come from Counter "ticket" ("T-3019") inside the creating transaction. A full license key typed into a
 *   subject or message is stored masked (the form says never to paste one).
 * - Activity entries (kind "ticket"): Opened ticket, Replied to ticket, Resolved ticket, Reopened ticket.
 * Server-only.
 */
import "server-only";
import type { Prisma, PrismaClient, TeamRole, TicketPriority, TicketStatus } from "@/generated/prisma/client";
import { nextTicketId } from "@/lib/counters";
import { DAY_MS } from "@/lib/dates";
import { db as defaultDb, type Db } from "@/lib/db";
import { errors } from "@/lib/http";
import { redactLicenseKeys } from "@/lib/licensing/keys";
import { log } from "@/lib/log";
import { teamCan } from "@/lib/rbac";
import type { StorageDriver } from "@/lib/storage";
import {
  TICKET_AUTO_CLOSE_DAYS,
  TICKET_ERRORS,
  TICKET_IMPACT_META,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUS_META,
  TICKETS_PAGE_SIZE,
  type CreateTicketInput,
  type TicketListQuery,
  type TicketPriorityKey,
  type TicketReplyInput,
  type TicketStatusFilter,
  type TicketStatusKey,
} from "@/lib/validation/tickets";
import { actorLabel, recordAccountActivity } from "./activity";
import { attachmentsJson, attachmentViews, attachUploads, verifyAttachableUploads, type AttachmentView } from "./uploads";

/** Messages returned with one ticket (long threads are rare; the newest are kept). */
export const TICKET_MESSAGES_LIMIT = 500;
/** "Reply target" in the ticket's details panel (prototype). */
export const TICKET_REPLY_TARGET = "1 business day";
/** "Assigned to" when no one has picked the ticket up. */
export const SUPPORT_QUEUE_LABEL = "Support queue";
export const STAFF_AUTHOR_SUFFIX = "Axiomatic Support";

export const TICKET_MESSAGES = {
  resolved: "This ticket is resolved. Reopen it to reply.",
  closed: "This ticket is closed and can’t be reopened. Start a new ticket if you still need help.",
  changed: "This ticket changed while you were working on it. Refresh the page and try again.",
} as const;

const STATUS_KEYS: Readonly<Record<TicketStatus, TicketStatusKey>> = {
  OPEN: "open",
  AWAITING_CUSTOMER: "awaiting_customer",
  RESOLVED: "resolved",
  CLOSED: "closed",
};
const PRIORITY_KEYS: Readonly<Record<TicketPriority, TicketPriorityKey>> = { LOW: "low", NORMAL: "normal", HIGH: "high" };

/** The status the portal shows: RESOLVED turns into "closed" TICKET_AUTO_CLOSE_DAYS after resolvedAt. */
export function deriveTicketStatus(ticket: { status: TicketStatus; resolvedAt: Date | null }, now: Date): TicketStatusKey {
  if (ticket.status === "RESOLVED" && ticket.resolvedAt && now.getTime() - ticket.resolvedAt.getTime() >= TICKET_AUTO_CLOSE_DAYS * DAY_MS) {
    return "closed";
  }
  return STATUS_KEYS[ticket.status];
}

/** Stored statuses each list tab covers. */
export function statusesForFilter(filter: TicketStatusFilter): TicketStatus[] | null {
  switch (filter) {
    case "open":
      return ["OPEN", "AWAITING_CUSTOMER"];
    case "awaiting_customer":
      return ["AWAITING_CUSTOMER"];
    case "resolved":
      return ["RESOLVED", "CLOSED"];
    default:
      return null;
  }
}

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter((w) => /\p{L}|\p{N}/u.test(w));
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0] ?? "");
  return letters.join("").toUpperCase() || "?";
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** "Sneha · Axiomatic Support" for staff, the member's name (or email) for customers. */
export function authorLabel(author: { name: string; email: string; kind: "CUSTOMER" | "STAFF" }, isStaff: boolean): string {
  if (isStaff) {
    const first = firstName(author.name);
    return first ? `${first} \u00B7 ${STAFF_AUTHOR_SUFFIX}` : STAFF_AUTHOR_SUFFIX;
  }
  return actorLabel(author);
}

function cleanText(text: string): string {
  return redactLicenseKeys(text);
}

// ---------- Shapes ----------

export type TicketSummary = {
  id: string;
  subject: string;
  productId: string | null;
  /** Full product name ("Medical Store Billing"); null when the ticket has no product. */
  productName: string | null;
  /** Short name for tables ("Medical"). */
  productShortName: string | null;
  licenseId: string | null;
  priority: TicketPriorityKey;
  priorityLabel: string;
  status: TicketStatusKey;
  statusLabel: string;
  statusTone: "blue" | "peach" | "sage" | "neutral";
  createdAt: string;
  updatedAt: string;
  /** Who opened it ("RAISED BY"). */
  raisedBy: string;
};

export type TicketListPage = {
  tickets: TicketSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Tickets per tab for the current product and search (the status filter itself is ignored). */
  counts: Record<TicketStatusFilter, number>;
};

export type TicketMessageView = {
  id: string;
  author: { name: string; label: string; initials: string; isStaff: boolean; isYou: boolean };
  body: string;
  createdAt: string;
  attachments: AttachmentView[];
};

export type TicketDetail = {
  ticket: TicketSummary & {
    /** First name of the assigned support person, or null ("Support queue"). */
    assigneeName: string | null;
    assigneeLabel: string;
    resolvedAt: string | null;
    closedAt: string | null;
    replyTarget: string;
    /** For the viewer's role and the ticket's status. */
    canReply: boolean;
    canResolve: boolean;
    canReopen: boolean;
  };
  messages: TicketMessageView[];
};

type TicketRowForSummary = {
  id: string;
  subject: string;
  productId: string | null;
  licenseId: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  openedBy: { name: string; email: string } | null;
};

type ProductNames = Map<string, { name: string; shortName: string }>;

async function productNames(client: Db, ids: Iterable<string | null>): Promise<ProductNames> {
  const unique = [...new Set([...ids].filter((v): v is string => typeof v === "string"))];
  if (unique.length === 0) return new Map();
  const rows = await client.product.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, shortName: true } });
  return new Map(rows.map((r) => [r.id, { name: r.name, shortName: r.shortName }]));
}

/** Opener for tickets without openedById (sample and older tickets): the author of the first message. */
async function firstAuthors(client: Db, ticketIds: string[]): Promise<Map<string, { name: string; email: string }>> {
  if (ticketIds.length === 0) return new Map();
  const rows = await client.ticketMessage.findMany({
    where: { ticketId: { in: ticketIds }, isStaff: false, internal: false },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    distinct: ["ticketId"],
    select: { ticketId: true, author: { select: { name: true, email: true } } },
  });
  return new Map(rows.map((r) => [r.ticketId, r.author]));
}

function toSummary(row: TicketRowForSummary, products: ProductNames, opener: { name: string; email: string } | undefined, now: Date): TicketSummary {
  const status = deriveTicketStatus(row, now);
  const product = row.productId ? products.get(row.productId) : undefined;
  const priority = PRIORITY_KEYS[row.priority];
  const by = row.openedBy ?? opener;
  return {
    id: row.id,
    subject: row.subject,
    productId: row.productId,
    productName: product?.name ?? null,
    productShortName: product?.shortName ?? null,
    licenseId: row.licenseId,
    priority,
    priorityLabel: TICKET_PRIORITY_LABELS[priority],
    status,
    statusLabel: TICKET_STATUS_META[status].label,
    statusTone: TICKET_STATUS_META[status].tone,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    raisedBy: by ? actorLabel(by) : "\u2014",
  };
}

const SUMMARY_SELECT = {
  id: true,
  subject: true,
  productId: true,
  licenseId: true,
  priority: true,
  status: true,
  resolvedAt: true,
  createdAt: true,
  updatedAt: true,
  openedBy: { select: { name: true, email: true } },
} as const satisfies Prisma.SupportTicketSelect;

function orderFor(sort: TicketListQuery["sort"]): Prisma.SupportTicketOrderByWithRelationInput[] {
  const dir = sort.dir === 1 ? "asc" : "desc";
  switch (sort.key) {
    case "created":
      return [{ createdAt: dir }, { id: dir }];
    case "priority":
      return [{ priority: dir }, { updatedAt: "desc" }, { id: "desc" }];
    case "status":
      return [{ status: dir }, { updatedAt: "desc" }, { id: "desc" }];
    case "subject":
      return [{ subject: dir }, { updatedAt: "desc" }, { id: "desc" }];
    default:
      return [{ updatedAt: dir }, { id: dir }];
  }
}

/** One page of the account's tickets, with per-tab counts. */
export async function listTickets(
  input: { accountId: string; query: TicketListQuery; now?: Date },
  client: Db = defaultDb,
): Promise<TicketListPage> {
  const now = input.now ?? new Date();
  const { query } = input;
  const base: Prisma.SupportTicketWhereInput = { accountId: input.accountId };
  if (query.product !== "all") base.productId = query.product;
  const q = query.q.trim();
  if (q) base.OR = [{ id: { contains: q, mode: "insensitive" } }, { subject: { contains: q, mode: "insensitive" } }];
  const statuses = statusesForFilter(query.status);
  const where: Prisma.SupportTicketWhereInput = statuses ? { ...base, status: { in: statuses } } : base;

  const grouped = await client.supportTicket.groupBy({ by: ["status"], where: base, _count: { _all: true } });
  const byStatus = new Map(grouped.map((g) => [g.status, g._count._all]));
  const n = (s: TicketStatus) => byStatus.get(s) ?? 0;
  const counts: Record<TicketStatusFilter, number> = {
    open: n("OPEN") + n("AWAITING_CUSTOMER"),
    awaiting_customer: n("AWAITING_CUSTOMER"),
    resolved: n("RESOLVED") + n("CLOSED"),
    all: n("OPEN") + n("AWAITING_CUSTOMER") + n("RESOLVED") + n("CLOSED"),
  };
  const total = statuses ? statuses.reduce((sum, s) => sum + n(s), 0) : counts.all;
  const pageCount = Math.max(1, Math.ceil(total / TICKETS_PAGE_SIZE));

  const rows = await client.supportTicket.findMany({
    where,
    orderBy: orderFor(query.sort),
    skip: (query.page - 1) * TICKETS_PAGE_SIZE,
    take: TICKETS_PAGE_SIZE,
    select: SUMMARY_SELECT,
  });
  const products = await productNames(client, rows.map((r) => r.productId));
  const openers = await firstAuthors(client, rows.filter((r) => !r.openedBy).map((r) => r.id));
  return {
    tickets: rows.map((r) => toSummary(r, products, openers.get(r.id), now)),
    total,
    page: query.page,
    pageSize: TICKETS_PAGE_SIZE,
    pageCount,
    counts,
  };
}

// ---------- Detail ----------

export type TicketViewer = { accountId: string; userId: string; role: TeamRole };

/** One ticket with its customer-visible messages, oldest first. 404 outside the account. */
export async function getTicketDetail(input: TicketViewer & { ticketId: string; now?: Date }, client: Db = defaultDb): Promise<TicketDetail> {
  const now = input.now ?? new Date();
  const row = await client.supportTicket.findFirst({
    where: { id: input.ticketId, accountId: input.accountId },
    select: { ...SUMMARY_SELECT, closedAt: true, assignee: { select: { name: true } } },
  });
  if (!row) throw errors.notFound("Ticket");
  const newest = await client.ticketMessage.findMany({
    where: { ticketId: row.id, internal: false },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: TICKET_MESSAGES_LIMIT,
    select: {
      id: true,
      authorId: true,
      isStaff: true,
      body: true,
      attachments: true,
      createdAt: true,
      author: { select: { name: true, email: true, kind: true } },
    },
  });
  const messages = newest.reverse();
  const products = await productNames(client, [row.productId]);
  const firstCustomer = messages.find((m) => !m.isStaff);
  const summary = toSummary(row, products, firstCustomer?.author, now);
  const mayWrite = teamCan(input.role, "tickets.create");
  const open = summary.status === "open" || summary.status === "awaiting_customer";
  const assigneeName = row.assignee ? firstName(row.assignee.name) || null : null;
  return {
    ticket: {
      ...summary,
      assigneeName,
      assigneeLabel: assigneeName ?? SUPPORT_QUEUE_LABEL,
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      closedAt: row.closedAt?.toISOString() ?? null,
      replyTarget: TICKET_REPLY_TARGET,
      canReply: mayWrite && open,
      canResolve: mayWrite && open,
      canReopen: mayWrite && summary.status === "resolved",
    },
    messages: messages.map((m) => {
      const label = authorLabel(m.author, m.isStaff);
      return {
        id: m.id,
        author: {
          name: m.isStaff ? firstName(m.author.name) || STAFF_AUTHOR_SUFFIX : actorLabel(m.author),
          label,
          initials: initialsOf(m.isStaff ? m.author.name : label),
          isStaff: m.isStaff,
          isYou: !m.isStaff && m.authorId === input.userId,
        },
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        attachments: attachmentViews(m.attachments),
      };
    }),
  };
}

// ---------- Writes ----------

export type TicketActor = TicketViewer & { user: { id: string; name: string; email: string } };

/** The product must exist and be on sale, or be one the account holds a license for (422 on `productId`). */
async function assertTicketProduct(client: Db, accountId: string, productId: string): Promise<void> {
  const product = await client.product.findUnique({ where: { id: productId }, select: { status: true } });
  if (product?.status === "PUBLISHED") return;
  if (product) {
    const licensed = await client.license.findFirst({ where: { accountId, productId }, select: { id: true } });
    if (licensed) return;
  }
  throw errors.validation({ productId: TICKET_ERRORS.product });
}

/** "Related license (optional)": one of the account's licenses for that product (422 on `licenseId`, never 404). */
async function assertTicketLicense(client: Db, accountId: string, productId: string, licenseId: string | null): Promise<void> {
  if (!licenseId) return;
  const license = await client.license.findFirst({ where: { id: licenseId, accountId, productId }, select: { id: true } });
  if (!license) throw errors.validation({ licenseId: TICKET_ERRORS.license });
}

/**
 * Opens a ticket (status OPEN) with its first message and attachments, and logs "Opened ticket". Returns the detail.
 * 422 for an unknown product, a license outside the account or product, or unavailable attachments.
 */
export async function createTicket(
  input: TicketActor & { data: CreateTicketInput; now?: Date },
  client: PrismaClient = defaultDb,
  storage?: StorageDriver,
): Promise<TicketDetail> {
  const now = input.now ?? new Date();
  const { data } = input;
  await assertTicketProduct(client, input.accountId, data.productId);
  await assertTicketLicense(client, input.accountId, data.productId, data.licenseId);
  const uploads = await verifyAttachableUploads({ accountId: input.accountId, userId: input.user.id, ids: data.attachmentIds, now }, client, storage);

  const ticketId = await client.$transaction(async (tx) => {
    const id = await nextTicketId(tx);
    await tx.supportTicket.create({
      data: {
        id,
        accountId: input.accountId,
        productId: data.productId,
        licenseId: data.licenseId,
        subject: cleanText(data.subject),
        priority: TICKET_IMPACT_META[data.impact].priority,
        status: "OPEN",
        openedById: input.user.id,
        createdAt: now,
        updatedAt: now,
      },
    });
    const message = await tx.ticketMessage.create({
      data: {
        ticketId: id,
        authorId: input.user.id,
        isStaff: false,
        internal: false,
        body: cleanText(data.body),
        attachments: attachmentsJson(uploads),
        createdAt: now,
      },
      select: { id: true },
    });
    await attachUploads(tx, { accountId: input.accountId, userId: input.user.id, ids: data.attachmentIds, ticketMessageId: message.id, now });
    await recordAccountActivity(tx, {
      accountId: input.accountId,
      actor: { id: input.user.id, name: actorLabel(input.user) },
      action: "Opened ticket",
      target: id,
      kind: "ticket",
      at: now,
    });
    return id;
  });
  log.info("ticket_opened", { ticketId, accountId: input.accountId, attachments: uploads.length });
  return getTicketDetail({ accountId: input.accountId, userId: input.user.id, role: input.role, ticketId, now }, client);
}

async function loadForWrite(client: Db, accountId: string, ticketId: string) {
  const ticket = await client.supportTicket.findFirst({
    where: { id: ticketId, accountId },
    select: { id: true, status: true, resolvedAt: true },
  });
  if (!ticket) throw errors.notFound("Ticket");
  return ticket;
}

const changedError = () => errors.conflict("ticket_changed", TICKET_MESSAGES.changed);

/**
 * Adds a customer reply. AWAITING_CUSTOMER goes back to OPEN ("Waiting for support"); logs "Replied to ticket".
 * 409 `ticket_resolved` (reopen first), 409 `ticket_closed`, 409 `ticket_changed` on a concurrent status change.
 */
export async function replyToTicket(
  input: TicketActor & { ticketId: string; data: TicketReplyInput; now?: Date },
  client: PrismaClient = defaultDb,
  storage?: StorageDriver,
): Promise<TicketDetail> {
  const now = input.now ?? new Date();
  const ticket = await loadForWrite(client, input.accountId, input.ticketId);
  const status = deriveTicketStatus(ticket, now);
  if (status === "closed") throw errors.conflict("ticket_closed", TICKET_MESSAGES.closed);
  if (status === "resolved") throw errors.conflict("ticket_resolved", TICKET_MESSAGES.resolved);
  const uploads = await verifyAttachableUploads(
    { accountId: input.accountId, userId: input.user.id, ids: input.data.attachmentIds, now },
    client,
    storage,
  );

  await client.$transaction(async (tx) => {
    const moved = await tx.supportTicket.updateMany({
      where: { id: ticket.id, accountId: input.accountId, status: { in: ["OPEN", "AWAITING_CUSTOMER"] } },
      data: { status: "OPEN", updatedAt: now },
    });
    if (moved.count !== 1) throw changedError();
    const message = await tx.ticketMessage.create({
      data: {
        ticketId: ticket.id,
        authorId: input.user.id,
        isStaff: false,
        internal: false,
        body: cleanText(input.data.body),
        attachments: attachmentsJson(uploads),
        createdAt: now,
      },
      select: { id: true },
    });
    await attachUploads(tx, { accountId: input.accountId, userId: input.user.id, ids: input.data.attachmentIds, ticketMessageId: message.id, now });
    await recordAccountActivity(tx, {
      accountId: input.accountId,
      actor: { id: input.user.id, name: actorLabel(input.user) },
      action: "Replied to ticket",
      target: ticket.id,
      kind: "ticket",
      at: now,
    });
  });
  log.info("ticket_replied", { ticketId: ticket.id, accountId: input.accountId, attachments: uploads.length });
  return getTicketDetail({ ...input, now }, client);
}

/**
 * "Mark resolved" (open -> RESOLVED, resolvedAt = now) and "Reopen" (RESOLVED -> OPEN). Repeating an action that is
 * already in effect changes nothing (200, no log entry). CLOSED tickets answer 409 `ticket_closed`.
 */
export async function changeTicketStatus(
  input: TicketActor & { ticketId: string; action: "resolve" | "reopen"; now?: Date },
  client: PrismaClient = defaultDb,
): Promise<TicketDetail> {
  const now = input.now ?? new Date();
  const ticket = await loadForWrite(client, input.accountId, input.ticketId);
  const status = deriveTicketStatus(ticket, now);
  if (status === "closed") throw errors.conflict("ticket_closed", TICKET_MESSAGES.closed);

  const resolving = input.action === "resolve";
  const alreadyThere = resolving ? status === "resolved" : status === "open" || status === "awaiting_customer";
  if (!alreadyThere) {
    await client.$transaction(async (tx) => {
      const changed = resolving
        ? await tx.supportTicket.updateMany({
            where: { id: ticket.id, accountId: input.accountId, status: { in: ["OPEN", "AWAITING_CUSTOMER"] } },
            data: { status: "RESOLVED", resolvedAt: now, updatedAt: now },
          })
        : await tx.supportTicket.updateMany({
            // Re-checks the auto-close window under the update, so a ticket cannot be reopened past it.
            where: {
              id: ticket.id,
              accountId: input.accountId,
              status: "RESOLVED",
              OR: [{ resolvedAt: null }, { resolvedAt: { gt: new Date(now.getTime() - TICKET_AUTO_CLOSE_DAYS * DAY_MS) } }],
            },
            data: { status: "OPEN", resolvedAt: null, closedAt: null, updatedAt: now },
          });
      if (changed.count !== 1) throw changedError();
      await recordAccountActivity(tx, {
        accountId: input.accountId,
        actor: { id: input.user.id, name: actorLabel(input.user) },
        action: resolving ? "Resolved ticket" : "Reopened ticket",
        target: ticket.id,
        kind: "ticket",
        at: now,
      });
    });
    log.info(resolving ? "ticket_resolved" : "ticket_reopened", { ticketId: ticket.id, accountId: input.accountId });
  }
  return getTicketDetail({ ...input, now }, client);
}

/** Count for the portal nav badge: tickets that are not resolved or closed. */
export async function countOpenTickets(client: Db, accountId: string): Promise<number> {
  return client.supportTicket.count({ where: { accountId, status: { in: ["OPEN", "AWAITING_CUSTOMER"] } } });
}
