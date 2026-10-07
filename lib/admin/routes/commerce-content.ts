/**
 * Admin route registry: Coupons, Content & FAQs, site banner and sample notice, Templates and Leads.
 * One entry per exported method of each route.ts under app/api/admin in this area (see ./types.ts and
 * tests/db/admin-permissions.test.ts). Only this area's builder edits this file.
 *
 * Sample bodies are harmless: `{}` fails validation (422) or the dummy id answers 404 before anything is written,
 * and no email is ever sent (the template test needs a real template id).
 */
import type { AdminRouteSpec } from "./types";

export const ROUTES: readonly AdminRouteSpec[] = [
  // Coupons (module open to every staff role; writes need coupons.manage)
  { method: "GET", path: "/api/admin/coupons", perm: null, sampleQuery: "filter[status]=active&sort=-starts" },
  { method: "POST", path: "/api/admin/coupons", perm: "coupons.manage", sampleBody: {} },
  { method: "GET", path: "/api/admin/coupons/export.csv", perm: "reports.export" },
  { method: "GET", path: "/api/admin/coupons/[code]", perm: null },
  { method: "PATCH", path: "/api/admin/coupons/[code]", perm: "coupons.manage", sampleBody: {} },
  { method: "DELETE", path: "/api/admin/coupons/[code]", perm: "coupons.manage", sampleBody: {} },
  { method: "POST", path: "/api/admin/coupons/[code]/pause", perm: "coupons.manage" },
  { method: "POST", path: "/api/admin/coupons/[code]/activate", perm: "coupons.manage" },

  // Content & FAQs
  { method: "GET", path: "/api/admin/faqs", perm: "content.manage", sampleQuery: "filter[page]=home&filter[status]=published" },
  { method: "POST", path: "/api/admin/faqs", perm: "content.manage", sampleBody: {} },
  { method: "GET", path: "/api/admin/faqs/export.csv", perm: "content.manage", alsoRequires: ["reports.export"] },
  { method: "POST", path: "/api/admin/faqs/bulk", perm: "content.manage", sampleBody: {} },
  { method: "GET", path: "/api/admin/faqs/[id]", perm: "content.manage" },
  { method: "PATCH", path: "/api/admin/faqs/[id]", perm: "content.manage", sampleBody: {} },
  { method: "DELETE", path: "/api/admin/faqs/[id]", perm: "content.manage", sampleBody: {} },
  { method: "POST", path: "/api/admin/faqs/[id]/move", perm: "content.manage", sampleBody: {} },
  { method: "GET", path: "/api/admin/content/banner", perm: "content.manage" },
  { method: "PATCH", path: "/api/admin/content/banner", perm: "content.manage", sampleBody: {} },
  { method: "GET", path: "/api/admin/content/sample-notice", perm: "content.manage" },
  { method: "PATCH", path: "/api/admin/content/sample-notice", perm: "content.manage", sampleBody: {} },

  // Notification templates
  { method: "GET", path: "/api/admin/templates", perm: "templates.manage" },
  { method: "GET", path: "/api/admin/templates/export.csv", perm: "templates.manage", alsoRequires: ["reports.export"] },
  { method: "GET", path: "/api/admin/templates/[id]", perm: "templates.manage" },
  { method: "PATCH", path: "/api/admin/templates/[id]", perm: "templates.manage", sampleBody: {} },
  { method: "POST", path: "/api/admin/templates/[id]/test", perm: "templates.manage", sampleBody: {} },

  // Leads (contact and demo requests)
  { method: "GET", path: "/api/admin/leads", perm: "leads.view", sampleQuery: "filter[kind]=demo&filter[status]=new&sort=-received" },
  { method: "GET", path: "/api/admin/leads/export.csv", perm: "leads.view", alsoRequires: ["reports.export"] },
  { method: "GET", path: "/api/admin/leads/[id]", perm: "leads.view" },
  { method: "PATCH", path: "/api/admin/leads/[id]", perm: "leads.view", sampleBody: {} },
];
