import { Suspense } from "react";
import { adminPageMetadata } from "@/components/admin/admin-nav";
import { LockedModule } from "@/components/admin/locked-module";
import { AdminModulePage } from "@/components/admin/module-page";
import { ticketStatsRow } from "@/components/admin/tickets/stats";
import { TicketsConsole } from "@/components/admin/tickets/tickets-console";
import { getAdminState } from "@/lib/admin/context";
import { ADMIN_TICKETS_LIST, ticketQueryFromListState } from "@/lib/admin/tickets/model";
import { listAdminTickets, ticketAssignees, ticketProducts, ticketStats, ticketStatusWhere } from "@/lib/admin/tickets/service";
import { db } from "@/lib/db";
import { adminModule } from "@/lib/rbac";
import { parseListState } from "@/lib/url-state";

export const metadata = adminPageMetadata("tickets");

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Support tickets (Admin Console.dc.html #tickets; decisions.md Phase 6 "Tickets (staff)"). Needs `tickets.manage`
 * (Owner, Administrator, Support); Finance gets the permission-denied panel and none of the data. The list state
 * (search, filters, sort, page) is in the URL and applied here; the drawer (`?id=`) loads the ticket from the API.
 */
export default async function AdminTicketsPage({ searchParams }: Props) {
  const state = await getAdminState();
  if (state.kind !== "ready") return null;
  const ctx = state.context;
  if (!ctx.can("tickets.manage")) {
    return (
      <AdminModulePage moduleKey="tickets">
        <LockedModule title={adminModule("tickets").title} perm="tickets.manage" role={ctx.staff.role} />
      </AdminModulePage>
    );
  }

  const now = new Date();
  const query = ticketQueryFromListState(parseListState(await searchParams, ADMIN_TICKETS_LIST));
  const [list, stats, resolved, assignees, products] = await Promise.all([
    listAdminTickets({ query, staffId: ctx.staff.id, now }),
    ticketStats(db, now),
    // Prototype RESOLVED card: the same tickets as the "Resolved" status filter.
    db.supportTicket.count({ where: ticketStatusWhere("resolved", now) }),
    ticketAssignees(),
    ticketProducts(),
  ]);

  return (
    <AdminModulePage moduleKey="tickets" stats={ticketStatsRow({ ...stats, resolved })} statsLabel="Ticket totals">
      <Suspense>
        <TicketsConsole
          items={list.items}
          total={list.total}
          page={list.page}
          pageSize={list.pageSize}
          assignees={assignees}
          products={products}
          nowIso={now.toISOString()}
        />
      </Suspense>
    </AdminModulePage>
  );
}
