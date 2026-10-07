"use client";

import * as React from "react";
import type { AdminModuleView } from "@/components/admin/admin-nav";
import type { AdminContextData, AdminStaff } from "@/lib/admin/context";
import { can as roleCan, canViewModule, type AdminModuleKey, type Permission } from "@/lib/rbac";

export type { AdminContextData, AdminStaff };

export type AdminValue = {
  staff: AdminStaff;
  /** Whether the signed-in role holds `perm` (cosmetic; every /api/admin route enforces the same PERMS). */
  can: (perm: Permission) => boolean;
  /** Whether the role can open a module (locked modules render the permission-denied page). */
  canView: (key: AdminModuleKey) => boolean;
  /** Every admin module in sidebar order with { locked, badge, href } for this role. */
  modules: AdminModuleView[];
  /** Payments run in test mode (mock provider or a Razorpay test key). */
  testMode: boolean;
};

const AdminContext = React.createContext<AdminValue | null>(null);

/** Provides the admin shell context (app/admin/layout.tsx) to every client component in the console. */
export function AdminProvider({ value, children }: { value: AdminContextData; children: React.ReactNode }) {
  const role = value.staff.role;
  const can = React.useCallback((perm: Permission) => roleCan(role, perm), [role]);
  const canView = React.useCallback((key: AdminModuleKey) => canViewModule(role, key), [role]);
  const admin = React.useMemo<AdminValue>(
    () => ({ staff: value.staff, modules: value.modules, testMode: value.testMode, can, canView }),
    [value, can, canView],
  );
  return <AdminContext.Provider value={admin}>{children}</AdminContext.Provider>;
}

/** The admin context: staff { id, name, email, role }, can(perm), canView(module), modules, testMode. */
export function useAdmin(): AdminValue {
  const value = React.useContext(AdminContext);
  if (!value) throw new Error("useAdmin() must be used inside the admin layout (AdminProvider).");
  return value;
}

/** The admin context when rendered inside the admin layout, else null (shared components, the UI gallery). */
export function useAdminOptional(): AdminValue | null {
  return React.useContext(AdminContext);
}

/** Shorthand for useAdmin().can(perm). */
export function useCan(perm: Permission): boolean {
  return useAdmin().can(perm);
}
