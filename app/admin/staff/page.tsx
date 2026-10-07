import { adminPageMetadata } from "@/components/admin/admin-nav";
import { AdminModulePage } from "@/components/admin/module-page";
import { InviteStaffButton } from "@/components/admin/staff/invite-staff";
import { RolePermissionsPanel } from "@/components/admin/staff/role-permissions";
import { StaffView } from "@/components/admin/staff/staff-view";
import { drawerIdParam, toUrlSearchParams, type PageSearchParams } from "@/lib/admin/audit/params";
import { parseListQuery } from "@/lib/admin/list-query";
import { STAFF_LIST_SPEC, type StaffRow } from "@/lib/admin/staff/model";
import { getStaffMember, listStaff } from "@/lib/admin/staff/service";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";

export const metadata = adminPageMetadata("staff");

/** Rendered (and its data loaded) only for roles that can open the module (AdminModulePage gate: staff.manage). */
async function StaffSection({ params }: { params: PageSearchParams }) {
  const now = new Date();
  const page = await listStaff(db, parseListQuery(toUrlSearchParams(params), STAFF_LIST_SPEC), now);
  const id = drawerIdParam(params);
  let selected: StaffRow | null = null;
  if (id && !page.items.some((row) => row.id === id)) {
    selected = await getStaffMember(db, id, now).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    });
  }
  return <StaffView data={page} selected={selected} now={now.toISOString()} />;
}

/**
 * /admin/staff (Admin Console.dc.html #staff; decisions.md Phase 6 "Staff"): Owner only. Staff table with search,
 * CSV and the staff drawer (?id=), "Invite staff" in the header, and the role permissions matrix from lib/rbac.ts.
 */
export default async function AdminStaffPage({ searchParams }: { searchParams: Promise<PageSearchParams> }) {
  const params = await searchParams;
  return (
    <AdminModulePage moduleKey="staff" actions={<InviteStaffButton />}>
      <StaffSection params={params} />
      <RolePermissionsPanel />
    </AdminModulePage>
  );
}
