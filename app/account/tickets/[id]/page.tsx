import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadTicketDetail } from "@/components/account/tickets/data";
import { TICKETS_COPY } from "@/components/account/tickets/model";
import { TicketDetailView } from "@/components/account/tickets/ticket-detail";
import { getPortalContext } from "@/lib/portal/context";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [{ id }, portal] = await Promise.all([params, getPortalContext()]);
  const detail = await loadTicketDetail(portal, id);
  return { title: detail ? detail.ticket.subject : TICKETS_COPY.notFoundTitle };
}

/**
 * Ticket detail (prototype "Ticket detail"). The ticket must belong to the member's active account; anything else
 * (another account's ticket, an unknown or malformed id) renders "Ticket not found" with a 404 (./not-found.tsx).
 */
export default async function TicketPage({ params }: Props) {
  const [{ id }, portal] = await Promise.all([params, getPortalContext()]);
  const detail = await loadTicketDetail(portal, id);
  if (!detail) notFound();
  return <TicketDetailView key={detail.ticket.id} initial={detail} nowIso={new Date().toISOString()} />;
}
