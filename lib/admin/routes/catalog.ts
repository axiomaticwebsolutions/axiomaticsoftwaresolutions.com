/**
 * Admin route registry: Products, categories, Plans & pricing, Releases.
 * One entry per exported method of each route.ts under app/api/admin in this area (see ./types.ts and
 * tests/db/admin-permissions.test.ts). Only this area's builder edits this file.
 *
 * Sample bodies are the default `{}`: create and edit schemas answer 422 for it, and id routes answer 404 for the
 * dummy id, so the permission matrix never writes to the shared test schema. Deletes (destructive: a reason is
 * required) send a reason, so they too reach the 404 for the dummy id.
 */
import type { AdminRouteSpec } from "./types";

export const ROUTES: readonly AdminRouteSpec[] = [
  // Products
  { method: "GET", path: "/api/admin/products", perm: null },
  { method: "POST", path: "/api/admin/products", perm: "products.manage" },
  { method: "GET", path: "/api/admin/products/export.csv", perm: "reports.export" },
  { method: "GET", path: "/api/admin/products/[id]", perm: null },
  { method: "PATCH", path: "/api/admin/products/[id]", perm: "products.manage" },
  { method: "POST", path: "/api/admin/products/[id]/publish", perm: "products.manage" },
  { method: "POST", path: "/api/admin/products/[id]/coming-soon", perm: "products.manage" },
  { method: "POST", path: "/api/admin/products/[id]/hide", perm: "products.manage" },
  // Categories
  { method: "GET", path: "/api/admin/categories", perm: null },
  { method: "POST", path: "/api/admin/categories", perm: "products.manage" },
  { method: "GET", path: "/api/admin/categories/[id]", perm: null },
  { method: "PATCH", path: "/api/admin/categories/[id]", perm: "products.manage" },
  { method: "DELETE", path: "/api/admin/categories/[id]", perm: "products.manage", sampleBody: { reason: "Permission test" } },
  // Plans
  { method: "GET", path: "/api/admin/plans", perm: null },
  { method: "POST", path: "/api/admin/plans", perm: "pricing.manage" },
  { method: "GET", path: "/api/admin/plans/export.csv", perm: "reports.export" },
  { method: "POST", path: "/api/admin/plans/bulk-archive", perm: "pricing.manage" },
  { method: "GET", path: "/api/admin/plans/[id]", perm: null },
  { method: "PATCH", path: "/api/admin/plans/[id]", perm: "pricing.manage" },
  { method: "POST", path: "/api/admin/plans/[id]/archive", perm: "pricing.manage" },
  { method: "POST", path: "/api/admin/plans/[id]/restore", perm: "pricing.manage" },
  // Releases
  { method: "GET", path: "/api/admin/releases", perm: null },
  { method: "POST", path: "/api/admin/releases", perm: "releases.manage" },
  { method: "GET", path: "/api/admin/releases/export.csv", perm: "reports.export" },
  { method: "GET", path: "/api/admin/releases/[id]", perm: null },
  { method: "PATCH", path: "/api/admin/releases/[id]", perm: "releases.manage" },
  { method: "DELETE", path: "/api/admin/releases/[id]", perm: "releases.manage", sampleBody: { reason: "Permission test" } },
  { method: "POST", path: "/api/admin/releases/[id]/files", perm: "releases.manage" },
  { method: "POST", path: "/api/admin/releases/[id]/files/confirm", perm: "releases.manage" },
  { method: "DELETE", path: "/api/admin/releases/[id]/files/[fileId]", perm: "releases.manage", sampleBody: { reason: "Permission test" } },
  { method: "POST", path: "/api/admin/releases/[id]/publish", perm: "releases.manage" },
  { method: "POST", path: "/api/admin/releases/[id]/withdraw", perm: "releases.manage" },
];
