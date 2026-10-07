import type * as React from "react";
import { PermissionDenied } from "@/components/account/permission-denied";
import { getPortalContext } from "@/lib/portal/context";
import type { TeamPermission } from "@/lib/rbac";

export type RequireTeamPermProps = {
  perm: TeamPermission;
  /** Page name for the denied panel ("Team & access"). */
  area: string;
  children: React.ReactNode;
  /** Rendered instead of the standard PermissionDenied panel. */
  fallback?: React.ReactNode;
};

/**
 * Server gate for a portal page or section: renders `children` when the member's team role holds `perm`, else the
 * permission-denied panel (decisions.md Phase 5: owner-only pages show it when opened by URL). Pages must still load
 * their data through guarded APIs or loaders; this only decides what to render.
 */
export async function RequireTeamPerm({ perm, area, children, fallback }: RequireTeamPermProps) {
  const portal = await getPortalContext();
  if (portal.can(perm)) return <>{children}</>;
  return fallback ?? <PermissionDenied area={area} perm={perm} role={portal.role} />;
}
