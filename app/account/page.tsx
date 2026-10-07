import type { Metadata } from "next";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { PORTAL_PATHS } from "@/components/account/portal-nav";
import { OVERVIEW_COPY } from "@/components/account/overview/model";
import { OverviewView } from "@/components/account/overview/overview-view";
import { db } from "@/lib/db";
import { getPortalContext } from "@/lib/portal/context";
import { getAccountOverview } from "@/lib/portal/overview";

export const metadata: Metadata = { title: OVERVIEW_COPY.title };

/**
 * Portal Overview (/account; Customer Portal.dc.html vOverview, decisions.md Phase 5). Every team role may open it:
 * the data is the same model GET /api/account/overview returns (lib/portal/overview.ts), read directly for the
 * signed-in member's server-side active account. Recent activity is Owner-only (null for other roles, card hidden).
 * Loading state: app/account/loading.tsx (the prototype's tiles skeleton); errors: app/account/error.tsx.
 */
export default async function OverviewPage() {
  const ctx = await getPortalContext();
  const now = new Date();
  const overview = await getAccountOverview(
    db,
    { accountId: ctx.account.id, legalName: ctx.account.legalName, role: ctx.role },
    now,
  );
  return (
    <>
      <PageHeader
        title={OVERVIEW_COPY.title}
        description={OVERVIEW_COPY.description(ctx.account.legalName)}
        actions={
          <>
            <PageAction icon="support_agent" href={PORTAL_PATHS.newTicket} perm="tickets.create">
              {OVERVIEW_COPY.raiseTicket}
            </PageAction>
            <PageAction variant="primary" icon="download" href={PORTAL_PATHS.software}>
              {OVERVIEW_COPY.downloadSoftware}
            </PageAction>
          </>
        }
      />
      <OverviewView overview={overview} now={now} />
    </>
  );
}
