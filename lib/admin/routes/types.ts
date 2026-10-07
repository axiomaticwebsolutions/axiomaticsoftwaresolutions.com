/**
 * Shape of the admin route registry (one file per area in lib/admin/routes). Every route.ts under app/api/admin needs
 * one entry per exported method; tests/db/admin-permissions.test.ts fails for unregistered handlers, stale entries
 * and entries whose `perm` differs from the one the handler passes to adminRoute(). Pure and client-safe.
 */
import type { Permission } from "@/lib/rbac";

export const ADMIN_ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type AdminRouteMethod = (typeof ADMIN_ROUTE_METHODS)[number];

export type AdminRouteSpec = {
  method: AdminRouteMethod;
  /**
   * The route's folder path under app/ with dynamic segments as written on disk, route groups left out:
   * "/api/admin/orders/[id]/refund", "/api/admin/reports/export.csv".
   */
  path: `/api/admin${string}`;
  /** The permission adminRoute() enforces; null = any active staff member. */
  perm: Permission | null;
  /**
   * Permissions the handler checks on top of `perm` (e.g. reports.export inside csvExportResponse for the export of a
   * module that Finance cannot open). The matrix expects 403 `forbidden` from a role that holds `perm` but not these.
   */
  alsoRequires?: readonly Permission[];
  /**
   * JSON body the permission test sends (mutations). It must be harmless: the test calls the handler once per role
   * that holds `perm`, against a dummy id. A body that fails validation (422) still proves the permission check
   * passed, because adminRoute() checks the role before the handler runs. Default: `{}` for POST/PUT/PATCH/DELETE.
   */
  sampleBody?: unknown;
  /** Values for dynamic segments (default: "perm-test-0000" for every segment). */
  sampleParams?: Record<string, string | string[]>;
  /** Query string for the test request, without "?" (e.g. "filter[status]=paid"). */
  sampleQuery?: string;
};
