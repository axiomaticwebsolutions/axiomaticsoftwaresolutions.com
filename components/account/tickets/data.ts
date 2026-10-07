/**
 * Server loaders for the portal's support ticket pages. Everything is scoped to the signed-in member's active account
 * (getPortalContext(), never the URL) through lib/portal/tickets; another account's ticket reads as not found.
 */
import "server-only";
import { cache } from "react";
import { getSetting } from "@/lib/config";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import type { PortalContext } from "@/lib/portal/context";
import { getTicketDetail, listTickets, type TicketDetail, type TicketListPage } from "@/lib/portal/tickets";
import { isTicketIdShape } from "@/lib/validation/tickets";
import { ticketQueryFromListState, type TicketsListState } from "@/components/account/tickets/list-config";
import type { NewTicketLicense, NewTicketProduct } from "@/components/account/tickets/model";

export type TicketProductOption = { id: string; name: string };

/** Support hours for the list footer (Admin > Settings > business.hours; "(configurable)" while sample). */
export async function loadSupportHours(): Promise<{ hours: string; sample: boolean }> {
  const business = await getSetting(db, "business");
  return { hours: business.hours, sample: business.sample };
}

/**
 * One page of the account's tickets for the URL state. A page past the end shows the last page (like the orders
 * list). Also the products the account's tickets are about (the Product filter, shown with two or more).
 */
export async function loadTicketList(
  accountId: string,
  state: TicketsListState,
  now: Date,
): Promise<{ list: TicketListPage; products: TicketProductOption[] }> {
  const query = ticketQueryFromListState(state);
  let list = await listTickets({ accountId, query, now });
  if (list.tickets.length === 0 && list.total > 0 && query.page > list.pageCount) {
    list = await listTickets({ accountId, query: { ...query, page: list.pageCount }, now });
  }
  const grouped = await db.supportTicket.groupBy({ by: ["productId"], where: { accountId, productId: { not: null } } });
  const ids = grouped.flatMap((g) => (g.productId ? [g.productId] : []));
  const products =
    ids.length === 0
      ? []
      : await db.product.findMany({
          where: { id: { in: ids } },
          orderBy: [{ rank: "asc" }, { name: "asc" }],
          select: { id: true, name: true },
        });
  return { list, products };
}

/**
 * Products a ticket can be about (on sale, or licensed to the account, as POST /api/account/tickets accepts) and the
 * account's licenses with their plan names, for "Related license (optional)".
 */
export async function loadNewTicketOptions(accountId: string): Promise<{ products: NewTicketProduct[]; licenses: NewTicketLicense[] }> {
  const licenses = await db.license.findMany({
    where: { accountId },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    take: 500,
    select: { id: true, productId: true, plan: { select: { name: true } } },
  });
  const licensedIds = [...new Set(licenses.map((l) => l.productId))];
  const products = await db.product.findMany({
    where: { OR: [{ status: "PUBLISHED" }, { id: { in: licensedIds } }] },
    orderBy: [{ rank: "asc" }, { name: "asc" }],
    select: { id: true, name: true },
  });
  return {
    products,
    licenses: licenses.map((l) => ({ id: l.id, productId: l.productId, planName: l.plan.name })),
  };
}

/** One ticket for the signed-in member, or null when it is not on the active account (or the id is malformed). */
/** Cached per request (generateMetadata and the page share it). */
export const loadTicketDetail = cache(async (portal: PortalContext, rawId: string): Promise<TicketDetail | null> => {
  const id = safeDecode(rawId);
  if (!id || !isTicketIdShape(id)) return null;
  try {
    return await getTicketDetail({ accountId: portal.account.id, userId: portal.user.id, role: portal.role, ticketId: id });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
});

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
