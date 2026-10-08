import type { Metadata } from "next";
import { adminTitle } from "@/components/admin/admin-nav";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { StaffProfileView } from "@/components/admin/profile/profile-view";
import { PROFILE_COPY } from "@/lib/admin/profile/model";
import { loadAdminProfilePage } from "@/lib/admin/profile/service";

export const metadata: Metadata = { title: adminTitle(PROFILE_COPY.title), robots: { index: false, follow: false } };

/**
 * /admin/profile "My profile" (decisions.md 2026-10-08): every ACTIVE staff role, whatever its permissions, from the
 * top bar's account menu. Checked on the server (loadAdminProfilePage): signed-out visitors go to
 * /sign-in?next=/admin/profile, customers to /account, and staff without live access see the layout's notice. Name,
 * email and role, the two-step switch (off by default; codes are emailed), password and active sessions; the /api/me
 * routes behind the cards check the session and live staff access again.
 */
export default async function AdminProfilePage() {
  const data = await loadAdminProfilePage();
  if (!data) return null;
  return (
    <div>
      <AdminPageHeader title={PROFILE_COPY.title} description={PROFILE_COPY.description} />
      {/* Prototype ax-in, as in AdminModulePage: a short rise and fade with no fill mode. */}
      <div className="grid min-w-0 gap-3.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-250">
        <StaffProfileView profile={data.profile} sessions={data.sessions} now={data.now} />
      </div>
    </div>
  );
}
