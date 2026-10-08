/**
 * Admin route registry: Orders, payments, refunds and webhook replay.
 * One entry per exported method of each route.ts under app/api/admin in this area (see ./types.ts and
 * tests/db/admin-permissions.test.ts). Only this area's builder edits this file.
 */
import type { AdminRouteSpec } from "./types";

export const ROUTES: readonly AdminRouteSpec[] = [
  { method: "GET", path: "/api/admin/orders", perm: "orders.view", sampleQuery: "filter[status]=paid&sort=-totalPaise" },
  { method: "GET", path: "/api/admin/orders/export.csv", perm: "reports.export", sampleQuery: "filter[status]=refunded" },
  // Unknown ids are skipped (no email, no audit row): harmless for the permission test.
  { method: "POST", path: "/api/admin/orders/resend-invoices", perm: "orders.resend_invoice", sampleBody: { ids: ["perm-test-0000"] } },
  { method: "GET", path: "/api/admin/orders/[id]", perm: "orders.view" },
  { method: "GET", path: "/api/admin/orders/[id]/invoice.pdf", perm: "orders.view" },
  // A dummy order id answers 404 before any provider call or write.
  { method: "POST", path: "/api/admin/orders/[id]/refund", perm: "refunds.issue", sampleBody: { reason: "Permission test", confirmId: "perm-test-0000" } },
  { method: "POST", path: "/api/admin/orders/[id]/resend-invoice", perm: "orders.resend_invoice" },
  { method: "POST", path: "/api/admin/orders/[id]/review", perm: "refunds.issue", sampleBody: { reason: "Permission test" } },
  { method: "POST", path: "/api/admin/webhooks/[id]/replay", perm: "payments.replay" },
  // Admin records (2026-10-08). Empty bodies answer 422 (reason or validation) before any write; dummy ids 404.
  { method: "POST", path: "/api/admin/orders", perm: "orders.create" },
  { method: "POST", path: "/api/admin/orders/quote", perm: "orders.create" },
  { method: "POST", path: "/api/admin/orders/offline", perm: "payments.record_offline" },
  { method: "PATCH", path: "/api/admin/orders/[id]", perm: "orders.edit" },
  { method: "POST", path: "/api/admin/orders/[id]/cancel", perm: "orders.edit" },
  { method: "POST", path: "/api/admin/orders/[id]/payment-link", perm: "orders.create", sampleBody: { send: false } },
  { method: "POST", path: "/api/admin/orders/[id]/correct-billing", perm: "invoices.correct" },
  { method: "GET", path: "/api/admin/orders/[id]/credit-notes/[noteId]", perm: "orders.view" },
];
