import type { Metadata } from "next";
import { PageHeader } from "@/components/account/page-header";
import { RequireTeamPerm } from "@/components/account/require-team-perm";
import { loadNewTicketOptions } from "@/components/account/tickets/data";
import { TICKETS_COPY } from "@/components/account/tickets/model";
import { NewTicketForm } from "@/components/account/tickets/new-ticket-form";
import { getPortalContext } from "@/lib/portal/context";
import { readParam } from "@/lib/url-state";

export const metadata: Metadata = { title: "New support ticket" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * New support ticket (prototype "New support ticket"). Needs tickets.create (Owner, Billing admin, Technical
 * contact): a Viewer opening the URL gets the permission-denied panel. ?license=LIC-x or ?product=<id> preselects
 * the product and related license (for "Get help" links).
 */
export default async function NewTicketPage({ searchParams }: Props) {
  const [portal, params] = await Promise.all([getPortalContext(), searchParams]);
  const header = <PageHeader title={TICKETS_COPY.newTitle} description={TICKETS_COPY.newDescription} />;
  if (!portal.can("tickets.create")) {
    return (
      <>
        {header}
        <RequireTeamPerm perm="tickets.create" area="new support tickets">
          {null}
        </RequireTeamPerm>
      </>
    );
  }
  const options = await loadNewTicketOptions(portal.account.id);
  return (
    <>
      {header}
      <NewTicketForm
        products={options.products}
        licenses={options.licenses}
        prefill={{ product: readParam(params, "product") ?? null, license: readParam(params, "license") ?? null }}
      />
    </>
  );
}
