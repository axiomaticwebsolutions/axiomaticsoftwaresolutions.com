/**
 * Admin route registry: Staff & roles, Audit log and Settings.
 * One entry per exported method of each route.ts under app/api/admin in this area (see ./types.ts and
 * tests/db/admin-permissions.test.ts). Only this area's builder edits this file.
 *
 * Sample bodies are harmless against the dummy id: `{}` fails validation (invite, role change) or meets a 404
 * (unknown staff member, unknown settings section). The audit log has GET routes only (append-only).
 */
import type { AdminRouteSpec } from "./types";

export const ROUTES: readonly AdminRouteSpec[] = [
  // Staff & roles (Owner only)
  { method: "GET", path: "/api/admin/staff", perm: "staff.manage" },
  { method: "POST", path: "/api/admin/staff", perm: "staff.manage", sampleBody: {} },
  { method: "GET", path: "/api/admin/staff/export.csv", perm: "staff.manage" },
  { method: "GET", path: "/api/admin/staff/[id]", perm: "staff.manage" },
  { method: "PATCH", path: "/api/admin/staff/[id]", perm: "staff.manage", sampleBody: {} },
  { method: "POST", path: "/api/admin/staff/[id]/deactivate", perm: "staff.manage", sampleBody: { reason: "Permission test" } },
  { method: "POST", path: "/api/admin/staff/[id]/reactivate", perm: "staff.manage", sampleBody: { reason: "Permission test" } },
  { method: "POST", path: "/api/admin/staff/[id]/resend-invite", perm: "staff.manage", sampleBody: {} },
  { method: "DELETE", path: "/api/admin/staff/[id]/invite", perm: "staff.manage", sampleBody: { reason: "Permission test" } },
  // Audit log (Owner, Administrator; read-only)
  { method: "GET", path: "/api/admin/audit", perm: "audit.view" },
  { method: "GET", path: "/api/admin/audit/export.csv", perm: "audit.view" },
  { method: "GET", path: "/api/admin/audit/[id]", perm: "audit.view" },
  // Settings (Owner only)
  { method: "GET", path: "/api/admin/settings", perm: "settings.manage" },
  { method: "PATCH", path: "/api/admin/settings/[section]", perm: "settings.manage", sampleBody: {} },
];
