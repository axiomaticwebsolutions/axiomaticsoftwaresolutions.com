/**
 * Admin route registry: Support tickets.
 * One entry per exported method of each route.ts under app/api/admin in this area (see ./types.ts and
 * tests/db/admin-permissions.test.ts). Only this area's builder edits this file.
 */
import type { AdminRouteSpec } from "./types";

export const ROUTES: readonly AdminRouteSpec[] = [
  { method: "GET", path: "/api/admin/tickets", perm: "tickets.manage", sampleQuery: "filter[status]=open&sort=-updatedAt" },
  { method: "POST", path: "/api/admin/tickets/bulk", perm: "tickets.manage", sampleBody: {} },
  { method: "GET", path: "/api/admin/tickets/[id]", perm: "tickets.manage" },
  { method: "PATCH", path: "/api/admin/tickets/[id]", perm: "tickets.manage", sampleBody: { priority: "high" } },
  { method: "POST", path: "/api/admin/tickets/[id]/messages", perm: "tickets.manage", sampleBody: { body: "Permission test", internal: true } },
  { method: "POST", path: "/api/admin/tickets/[id]/uploads", perm: "tickets.manage", sampleBody: { fileName: "a.txt", contentType: "text/plain", sizeBytes: 1 } },
  { method: "POST", path: "/api/admin/tickets/[id]/uploads/[uploadId]/confirm", perm: "tickets.manage" },
  { method: "GET", path: "/api/admin/tickets/[id]/attachments/[uploadId]", perm: "tickets.manage" },
];
