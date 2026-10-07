/**
 * One definition of a ticket's first response (decisions.md Phase 6: "First response = firstResponseAt, else the
 * first public staff message"), shared by the Tickets page (stats, drawer), the Reports support workload and the
 * Support SLA export so the figures cannot drift apart. Tickets answered before firstResponseAt was recorded fall
 * back to their earliest public staff message (TicketMessage isStaff, not internal); internal notes never count.
 */
import "server-only";
import { Prisma } from "@/lib/db";

/**
 * SQL expression for the first response time of the "SupportTicket" row aliased `t` (NULL when nobody replied).
 * Use it in queries that select `FROM "SupportTicket" t`.
 */
export const FIRST_RESPONSE_AT_SQL = Prisma.sql`COALESCE(t."firstResponseAt", (
  SELECT MIN(m."createdAt") FROM "TicketMessage" m
  WHERE m."ticketId" = t."id" AND m."isStaff" = true AND m."internal" = false
))`;

/** Prisma `select` fragment: the earliest public staff message (for firstResponseOf). */
export const FIRST_STAFF_REPLY_SELECT = {
  where: { isStaff: true, internal: false },
  orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  take: 1,
  select: { createdAt: true },
} satisfies Prisma.SupportTicket$messagesArgs;

/** firstResponseAt, else the earliest public staff message loaded with FIRST_STAFF_REPLY_SELECT, else null. */
export function firstResponseOf(ticket: { firstResponseAt: Date | null; messages: readonly { createdAt: Date }[] }): Date | null {
  return ticket.firstResponseAt ?? ticket.messages[0]?.createdAt ?? null;
}
