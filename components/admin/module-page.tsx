import type * as React from "react";
import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { LockedModule } from "@/components/admin/locked-module";
import { StatsRow, type AdminStat } from "@/components/admin/stats-row";
import { getAdminState } from "@/lib/admin/context";
import { adminGroupTitle, adminModule, type AdminModuleKey } from "@/lib/rbac";

export type { AdminStat };

export type AdminModulePageProps = {
  /** The module (lib/rbac.ts ADMIN_MODULES): its gate, breadcrumb group, title and description. */
  moduleKey: AdminModuleKey;
  /** Page heading instead of the module title. */
  title?: string;
  /** Description instead of the module's. */
  description?: React.ReactNode;
  /** Header actions (AdminAction / DestructiveAction); hidden on the permission-denied page. */
  actions?: React.ReactNode;
  /** Stats row under the header (prototype orders, licenses, renewals, tickets). */
  stats?: readonly AdminStat[];
  /** Accessible name of the stats list (default "{title} summary"). */
  statsLabel?: string;
  className?: string;
  children?: React.ReactNode;
};

/**
 * Frame of every admin module page (server component): breadcrumb, H1, description and actions, the optional stats
 * row, then the module content. When the signed-in role cannot open the module it renders the permission-denied
 * page instead, and `actions`, `stats` and `children` are never rendered, so server components passed as children
 * do not run for that role. Pages that load data before rendering this must check ctx.canView(moduleKey) (or the
 * permission) themselves: `const ctx = await getAdminContext()`.
 */
export async function AdminModulePage({
  moduleKey,
  title,
  description,
  actions,
  stats,
  statsLabel,
  className,
  children,
}: AdminModulePageProps) {
  const state = await getAdminState();
  // Staff without live access: the layout shows its own notice instead of any page.
  if (state.kind !== "ready") return null;
  const ctx = state.context;
  const mod = adminModule(moduleKey);
  const heading = title ?? mod.title;
  const group = adminGroupTitle(mod.group);
  const text = description ?? mod.description;

  if (!ctx.canView(moduleKey) && mod.viewPerm) {
    return (
      <div className={className}>
        <AdminPageHeader group={group} title={heading} description={text} />
        <LockedModule title={heading} perm={mod.viewPerm} role={ctx.staff.role} />
      </div>
    );
  }

  return (
    <div className={className}>
      <AdminPageHeader group={group} title={heading} description={text} actions={actions} />
      {/* Prototype ax-in: a short rise and fade. No fill mode, so no transform stays behind to trap fixed children. */}
      <div className="grid min-w-0 gap-3.5 animate-in fade-in-0 slide-in-from-bottom-1 duration-250">
        {stats && stats.length > 0 ? <StatsRow stats={stats} aria-label={statsLabel ?? `${heading} summary`} /> : null}
        {children}
      </div>
    </div>
  );
}
