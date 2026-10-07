"use client";

import * as React from "react";
import type { PortalCounts } from "@/components/account/portal-nav";
import type { PortalContextData } from "@/lib/portal/context";
import { teamCan, type TeamPermission } from "@/lib/rbac";

export type { PortalContextData };

export type PortalValue = PortalContextData & {
  /** Whether the signed-in member's team role holds `perm` (cosmetic; the API enforces the same TEAM_PERMS). */
  can: (perm: TeamPermission) => boolean;
  /**
   * Adjusts badge counts until the next server render (e.g. 0 unread after "Mark all as read"). A router.refresh()
   * or navigation that re-renders the layout replaces them with the server's numbers.
   */
  updateCounts: (patch: Partial<PortalCounts>) => void;
};

const PortalContext = React.createContext<PortalValue | null>(null);

type CountsOverride = { base: PortalCounts; patch: Partial<PortalCounts> };

/** Provides the portal shell context (app/account/layout.tsx) to every client component in the portal. */
export function PortalProvider({ value, children }: { value: PortalContextData; children: React.ReactNode }) {
  const [override, setOverride] = React.useState<CountsOverride | null>(null);
  const base = value.counts;
  // An override only applies to the counts it was made against: new server props replace it.
  const counts = React.useMemo(
    () => (override && override.base === base ? { ...base, ...override.patch } : base),
    [override, base],
  );
  const updateCounts = React.useCallback(
    (patch: Partial<PortalCounts>) =>
      setOverride((prev) => ({ base, patch: prev && prev.base === base ? { ...prev.patch, ...patch } : patch })),
    [base],
  );
  const role = value.role;
  const can = React.useCallback((perm: TeamPermission) => teamCan(role, perm), [role]);
  const portal = React.useMemo<PortalValue>(
    () => ({ ...value, counts, can, updateCounts }),
    [value, counts, can, updateCounts],
  );
  return <PortalContext.Provider value={portal}>{children}</PortalContext.Provider>;
}

/** The portal context: user, active account, accounts, role, can(perm), locations and badge counts. */
export function usePortal(): PortalValue {
  const value = React.useContext(PortalContext);
  if (!value) throw new Error("usePortal() must be used inside the portal layout (PortalProvider).");
  return value;
}

/** The portal context when rendered inside the portal layout, else null (shared components). */
export function usePortalOptional(): PortalValue | null {
  return React.useContext(PortalContext);
}
