import type { Metadata } from "next";
import { ACTIVITY_COPY, ACTIVITY_LIST, activityQueryFromState } from "@/components/account/activity/activity-model";
import { ActivityView } from "@/components/account/activity/activity-view";
import { PageHeader } from "@/components/account/page-header";
import { PermissionDenied } from "@/components/account/permission-denied";
import { RequireTeamPerm } from "@/components/account/require-team-perm";
import { db } from "@/lib/db";
import { listAccountActivity } from "@/lib/portal/activity";
import { getPortalContext } from "@/lib/portal/context";
import { parseListState, type SearchParamsInput } from "@/lib/url-state";

export const metadata: Metadata = { title: "Activity log" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Rendered (and its data loaded) only after RequireTeamPerm's `activity.view` check. */
async function ActivitySection({ params }: { params: SearchParamsInput }) {
  const portal = await getPortalContext();
  const query = activityQueryFromState(parseListState(params, ACTIVITY_LIST));
  const page = await listAccountActivity(db, portal.account.id, query);
  return <ActivityView data={{ events: page.events, total: page.total, pageSize: page.pageSize }} />;
}

/**
 * /account/activity?kind=&q=&page= (Customer Portal.dc.html "Activity log"; decisions.md Phase 5 "Activity log").
 * Owner only: other roles get the permission-denied panel (the activity API answers 403 as well). The server renders
 * each page of 10 (newest first, 24 months); the client table changes the URL.
 */
export default async function ActivityPage({ searchParams }: { searchParams: SearchParams }) {
  const [portal, params] = await Promise.all([getPortalContext(), searchParams]);
  return (
    <RequireTeamPerm
      perm="activity.view"
      area={ACTIVITY_COPY.title}
      fallback={
        <>
          <PageHeader title={ACTIVITY_COPY.title} description={ACTIVITY_COPY.description} />
          <PermissionDenied area={ACTIVITY_COPY.title} perm="activity.view" role={portal.role} />
        </>
      }
    >
      <ActivitySection params={params} />
    </RequireTeamPerm>
  );
}
