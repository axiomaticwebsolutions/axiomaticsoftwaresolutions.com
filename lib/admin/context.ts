/**
 * Server side of the admin console shell (decisions.md Phase 6). One call per request (React cache):
 *
 * - signed out (or an expired session behind a stale cookie) -> /sign-in?next=<admin path>
 * - customers -> /account
 * - staff whose access is not active (invited, deactivated, no role) -> state "inactive" (the layout explains it)
 * - otherwise the staff member, every admin module with its lock for the role, the sidebar badge counts and whether
 *   payments run in test mode.
 *
 * The layout renders the shell from it; pages and AdminModulePage call getAdminContext() for the same cached value.
 * Layouts do not re-render on client navigation, so pages and every /api/admin route still authorize on their own.
 */
import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { OrderStatus, TicketStatus, type StaffRole } from "@/generated/prisma/client";
import {
  adminPathFrom,
  moduleViewsFor,
  type AdminBadgeCounts,
  type AdminModuleView,
} from "@/components/admin/admin-nav";
import { getCurrentAuth, hasLiveStaffAccess, type CurrentAuth, type StaffAuth } from "@/lib/auth/guards";
import { CUSTOMER_HOME, signInPath } from "@/lib/auth/redirect";
import { db, type Db } from "@/lib/db";
import { resolvePayments } from "@/lib/integrations/resolver";
import type { PaymentsConfig, Resolved } from "@/lib/integrations/types";
import { can, canViewModule, type AdminModuleKey, type Permission } from "@/lib/rbac";

/** Request header set by middleware.ts with the requested path + query (equals PORTAL_PATH_HEADER). */
export const ADMIN_PATH_HEADER = "x-axs-path";

/** Orders that wait on staff (sidebar badge, prototype: pending + in review). */
export const ORDER_BADGE_STATUSES = [OrderStatus.PENDING, OrderStatus.REVIEW] as const;

export type AdminStaff = { id: string; name: string; email: string; role: StaffRole };

/** Serializable shell data, handed to the client AdminProvider as is. */
export type AdminContextData = {
  staff: AdminStaff;
  /** Every module in sidebar order with { locked, badge } for this role. */
  modules: AdminModuleView[];
  /** The effective payments configuration is the mock or a Razorpay test key (the key itself never leaves the server). */
  testMode: boolean;
};

export type AdminContext = AdminContextData & {
  can: (perm: Permission) => boolean;
  canView: (key: AdminModuleKey) => boolean;
  /** Session and user as requireStaff() returns them. */
  auth: StaffAuth;
};

export type AdminState =
  | { kind: "ready"; context: AdminContext }
  | { kind: "inactive"; user: { id: string; name: string; email: string } };

/**
 * "Test mode" badge: the effective payments configuration (lib/integrations/resolver.ts) is the mock or Razorpay with an
 * `rzp_test_` key. Not configured -> false (no badge).
 */
export function isPaymentTestMode(payments: Resolved<PaymentsConfig>): boolean {
  return payments.source !== "none" && payments.config.mode === "test";
}

/** Where a visitor of `path` must go instead of the console, or null when they may stay (staff of any status). */
export function adminRedirect(auth: CurrentAuth | null, path: string): string | null {
  if (!auth) return signInPath(path);
  if (auth.user.kind !== "STAFF") return CUSTOMER_HOME;
  return null;
}

/** Staff whose console access is live: ACTIVE with a role (the same rule as requireStaff()). */
export function isActiveStaff(user: CurrentAuth["user"]): user is CurrentAuth["user"] & { staffRole: StaffRole } {
  return hasLiveStaffAccess(user);
}

/** Sidebar badge counts for the modules this role can open (one count query each, in parallel). */
export async function loadAdminBadges(client: Db, role: StaffRole): Promise<AdminBadgeCounts> {
  const [orders, tickets] = await Promise.all([
    canViewModule(role, "orders")
      ? client.order.count({ where: { status: { in: [...ORDER_BADGE_STATUSES] } } })
      : Promise.resolve(0),
    canViewModule(role, "tickets")
      ? client.supportTicket.count({ where: { status: TicketStatus.OPEN, assigneeId: null } })
      : Promise.resolve(0),
  ]);
  return { orders, tickets };
}

/** Shell data for an active staff member. */
export async function loadAdminData(
  client: Db,
  user: { id: string; name: string; email: string; staffRole: StaffRole },
  payments?: Resolved<PaymentsConfig>,
): Promise<AdminContextData> {
  const [badges, effective] = await Promise.all([loadAdminBadges(client, user.staffRole), payments ?? resolvePayments()]);
  return {
    staff: { id: user.id, name: user.name, email: user.email, role: user.staffRole },
    modules: moduleViewsFor(user.staffRole, badges),
    testMode: isPaymentTestMode(effective),
  };
}

/** The requested admin path (from middleware), for redirect targets. */
async function requestedPath(): Promise<string> {
  return adminPathFrom((await headers()).get(ADMIN_PATH_HEADER));
}

/**
 * Shell state for this request (cached): redirects signed-out visitors and customers, reports staff without live
 * access as "inactive", else loads the admin context.
 */
export const getAdminState = cache(async (): Promise<AdminState> => {
  const auth = await getCurrentAuth();
  if (!auth || auth.user.kind !== "STAFF") redirect(adminRedirect(auth, await requestedPath()) ?? CUSTOMER_HOME);
  const { session, user } = auth;
  if (!isActiveStaff(user)) return { kind: "inactive", user: { id: user.id, name: user.name, email: user.email } };
  const data = await loadAdminData(db, user);
  const role = user.staffRole;
  return {
    kind: "ready",
    context: {
      ...data,
      can: (perm: Permission) => can(role, perm),
      canView: (key: AdminModuleKey) => canViewModule(role, key),
      auth: { session, user },
    },
  };
});

/** Thrown by getAdminContext() when the staff member's access is not active (the layout renders that state). */
export class AdminAccessInactiveError extends Error {
  constructor() {
    super("Staff access is not active.");
    this.name = "AdminAccessInactiveError";
  }
}

/**
 * The admin context for a page or server component (same cached value as the layout). Redirects like the layout;
 * throws when the staff member's access is not active (the layout shows that state instead of pages).
 */
export async function getAdminContext(): Promise<AdminContext> {
  const state = await getAdminState();
  if (state.kind !== "ready") throw new AdminAccessInactiveError();
  return state.context;
}

/** The serializable part of a context (what the layout passes to the client provider). */
export function toAdminContextData(context: AdminContext): AdminContextData {
  const { staff, modules, testMode } = context;
  return { staff, modules, testMode };
}
