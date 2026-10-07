import type { Metadata } from "next";
import { PageHeader } from "@/components/account/page-header";
import { PermissionDenied } from "@/components/account/permission-denied";
import { RequireTeamPerm } from "@/components/account/require-team-perm";
import { TEAM_COPY } from "@/components/account/team/team-model";
import { TeamView } from "@/components/account/team/team-view";
import { getPortalContext } from "@/lib/portal/context";
import { listTeam } from "@/lib/portal/team";

export const metadata: Metadata = { title: "Team & access" };

/** Rendered (and its data loaded) only after RequireTeamPerm's `team.manage` check. */
async function TeamSection() {
  const portal = await getPortalContext();
  const now = new Date();
  const team = await listTeam({ accountId: portal.account.id, viewerUserId: portal.user.id, now });
  return <TeamView initial={team} businessName={portal.account.legalName} now={now.getTime()} />;
}

/**
 * /account/team (Customer Portal.dc.html "Team & access"; decisions.md Phase 5 "Team"). Owner only: other roles get
 * the permission-denied panel under the page title (the nav hides the page from them; the team API answers 403 too).
 */
export default async function TeamPage() {
  const portal = await getPortalContext();
  return (
    <RequireTeamPerm
      perm="team.manage"
      area={TEAM_COPY.title}
      fallback={
        <>
          <PageHeader title={TEAM_COPY.title} description={TEAM_COPY.description} />
          <PermissionDenied area={TEAM_COPY.title} perm="team.manage" role={portal.role} />
        </>
      }
    >
      <TeamSection />
    </RequireTeamPerm>
  );
}
