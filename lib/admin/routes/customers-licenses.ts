/**
 * Admin route registry: Customers, Renewals and Licenses.
 * One entry per exported method of each route.ts under app/api/admin in this area (see ./types.ts and
 * tests/db/admin-permissions.test.ts). Only this area's builder edits this file.
 *
 * Sample bodies are harmless against the dummy id: mutations without a reason answer 422 reason_required, the
 * customer email actions 404 (no such account), manual issue / bulk / remind 422 (missing fields), customer create and
 * edit 422 (missing fields / nothing to change).
 */
import type { AdminRouteSpec } from "./types";

export const ROUTES: readonly AdminRouteSpec[] = [
  // Customers
  { method: "GET", path: "/api/admin/customers", perm: "customers.view", sampleQuery: "filter[gst]=yes&sort=-ltv" },
  { method: "POST", path: "/api/admin/customers", perm: "customers.create" },
  { method: "GET", path: "/api/admin/customers/export.csv", perm: "reports.export", sampleQuery: "q=perm-test-no-match" },
  { method: "GET", path: "/api/admin/customers/[id]", perm: "customers.view" },
  { method: "PATCH", path: "/api/admin/customers/[id]", perm: "customers.edit" },
  { method: "POST", path: "/api/admin/customers/[id]/verify-email", perm: "customers.verify_email" },
  { method: "POST", path: "/api/admin/customers/[id]/set-password-link", perm: "customers.manage" },
  { method: "POST", path: "/api/admin/customers/[id]/resend-verification", perm: "customers.manage" },
  { method: "POST", path: "/api/admin/customers/[id]/password-reset", perm: "customers.manage" },
  // Licenses (reads are open to every staff role: Finance sees the module read-only)
  { method: "GET", path: "/api/admin/licenses", perm: null, sampleQuery: "filter[status]=expiring&sort=-issued" },
  { method: "POST", path: "/api/admin/licenses", perm: "licenses.manage" },
  { method: "GET", path: "/api/admin/licenses/export.csv", perm: "reports.export", sampleQuery: "q=perm-test-no-match" },
  { method: "POST", path: "/api/admin/licenses/bulk", perm: "licenses.manage" },
  { method: "GET", path: "/api/admin/licenses/[id]", perm: null },
  { method: "POST", path: "/api/admin/licenses/[id]/suspend", perm: "licenses.manage" },
  { method: "POST", path: "/api/admin/licenses/[id]/reinstate", perm: "licenses.manage" },
  { method: "POST", path: "/api/admin/licenses/[id]/extend", perm: "licenses.manage" },
  { method: "POST", path: "/api/admin/licenses/[id]/reset-devices", perm: "licenses.manage" },
  { method: "POST", path: "/api/admin/licenses/[id]/revoke", perm: "licenses.revoke" },
  { method: "POST", path: "/api/admin/licenses/[id]/devices/[deviceId]/deactivate", perm: "licenses.manage" },
  // Renewals
  { method: "GET", path: "/api/admin/renewals", perm: "customers.view", sampleQuery: "filter[window]=30&sort=ends" },
  { method: "GET", path: "/api/admin/renewals/export.csv", perm: "reports.export", sampleQuery: "q=perm-test-no-match" },
  { method: "POST", path: "/api/admin/renewals/remind", perm: "renewals.remind" },
];
