/**
 * Every /api/admin route with its method and required permission, one file per area so module builders never edit the
 * same file. tests/db/admin-permissions.test.ts checks this list against the route files on disk and the permission
 * each handler passes to adminRoute(), then calls every entry as signed out, customer and each staff role.
 * Pure and client-safe.
 */
import { ROUTES as CATALOG } from "./catalog";
import { ROUTES as COMMERCE_CONTENT } from "./commerce-content";
import { ROUTES as CUSTOMERS_LICENSES } from "./customers-licenses";
import { ROUTES as FOUNDATION } from "./foundation";
import { ROUTES as ORDERS } from "./orders";
import { ROUTES as OVERVIEW_REPORTS } from "./overview-reports";
import { ROUTES as STAFF_AUDIT_SETTINGS } from "./staff-audit-settings";
import { ROUTES as TICKETS } from "./tickets";
import type { AdminRouteMethod, AdminRouteSpec } from "./types";

export { ADMIN_ROUTE_METHODS, type AdminRouteMethod, type AdminRouteSpec } from "./types";

/** Registry file (without .ts) -> its entries. */
export const ADMIN_ROUTE_AREAS = {
  "overview-reports": OVERVIEW_REPORTS,
  catalog: CATALOG,
  orders: ORDERS,
  "customers-licenses": CUSTOMERS_LICENSES,
  "commerce-content": COMMERCE_CONTENT,
  tickets: TICKETS,
  "staff-audit-settings": STAFF_AUDIT_SETTINGS,
  foundation: FOUNDATION,
} as const satisfies Record<string, readonly AdminRouteSpec[]>;

export type AdminRouteArea = keyof typeof ADMIN_ROUTE_AREAS;

export type RegisteredAdminRoute = AdminRouteSpec & { area: AdminRouteArea };

export const ADMIN_ROUTES: readonly RegisteredAdminRoute[] = (Object.keys(ADMIN_ROUTE_AREAS) as AdminRouteArea[]).flatMap(
  (area) => ADMIN_ROUTE_AREAS[area].map((spec) => ({ ...spec, area })),
);

/** "POST /api/admin/orders/[id]/refund" */
export function adminRouteKey(route: { method: AdminRouteMethod; path: string }): string {
  return `${route.method} ${route.path}`;
}

/** The registry entry for a method and path pattern, if any. */
export function findAdminRoute(method: AdminRouteMethod, path: string): RegisteredAdminRoute | undefined {
  return ADMIN_ROUTES.find((r) => r.method === method && r.path === path);
}
