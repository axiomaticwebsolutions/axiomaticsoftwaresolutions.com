import type { Metadata } from "next";
import { Suspense } from "react";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { PORTAL_PATHS } from "@/components/account/portal-nav";
import { loadSupportHours, loadTicketList } from "@/components/account/tickets/data";
import { TICKETS_LIST } from "@/components/account/tickets/list-config";
import { supportHoursNote, TICKETS_COPY } from "@/components/account/tickets/model";
import { TicketsTable } from "@/components/account/tickets/tickets-table";
import { getPortalContext } from "@/lib/portal/context";
import { parseListState } from "@/lib/url-state";

export const metadata: Metadata = { title: "Support tickets" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Support tickets (prototype "Support tickets"; decisions.md Phase 5 "Tickets"). Every team role can read the
 * account's tickets; "New ticket" is disabled with a "Requires ..." tooltip for roles without tickets.create.
 * Search, status, product, sort and page live in the URL and are applied here on the server.
 */
export default async function TicketsPage({ searchParams }: Props) {
  const [portal, params] = await Promise.all([getPortalContext(), searchParams]);
  const now = new Date();
  const state = parseListState(params, TICKETS_LIST);
  const [{ list, products }, hours] = await Promise.all([loadTicketList(portal.account.id, state, now), loadSupportHours()]);
  return (
    <>
      <PageHeader
        title={TICKETS_COPY.listTitle}
        description={TICKETS_COPY.listDescription}
        actions={
          <PageAction variant="primary" icon="add" href={PORTAL_PATHS.newTicket} perm="tickets.create">
            {TICKETS_COPY.newTicket}
          </PageAction>
        }
      />
      <Suspense>
        <TicketsTable list={list} products={products} footerNote={supportHoursNote(hours.hours, hours.sample)} nowIso={now.toISOString()} />
      </Suspense>
    </>
  );
}
