/**
 * Admin route registry: Overview and Reports.
 * One entry per exported method of each route.ts under app/api/admin in this area (see ./types.ts and
 * tests/db/admin-permissions.test.ts). Only this area's builder edits this file.
 */
import type { AdminRouteSpec } from "./types";

export const ROUTES: readonly AdminRouteSpec[] = [
  { method: "GET", path: "/api/admin/overview", perm: null, sampleQuery: "range=7d" },
  { method: "GET", path: "/api/admin/reports", perm: "reports.view", sampleQuery: "range=7d" },
  // Without `report` the export answers 422 before it reads or audits anything.
  { method: "GET", path: "/api/admin/reports/export.csv", perm: "reports.export" },
];
