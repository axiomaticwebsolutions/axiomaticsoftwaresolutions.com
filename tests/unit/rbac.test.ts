import { describe, expect, it } from "vitest";
import { StaffRole, TeamRole } from "@/generated/prisma/enums";
import {
  ADMIN_MODULES,
  DESTRUCTIVE_ACTIONS,
  PERMISSIONS,
  PERMS,
  REASON_MAX_LENGTH,
  STAFF_ROLES,
  STAFF_ROLE_LABELS,
  TEAM_MATRIX_ROWS,
  TEAM_PERMISSIONS,
  TEAM_PERMS,
  TEAM_ROLES,
  TEAM_ROLE_META,
  type Permission,
  type TeamPermission,
  adminGroupTitle,
  areaDeniedMessage,
  can,
  canViewModule,
  exportNeedsLabel,
  isPermission,
  lockedModulesFor,
  permissionsFor,
  requiresLabel,
  roleForbiddenMessage,
  rolesFor,
  teamCan,
  teamMatrixAllows,
  teamPermissionsFor,
  validateReason,
  validateTypedConfirmation,
} from "@/lib/rbac";

const ALL: StaffRole[] = ["OWNER", "ADMIN", "SUPPORT", "FINANCE"];

/** Expected map, written out independently from lib/rbac.ts (handoff PERMS + decisions.md section 7 + Phase 6 leads). */
const EXPECTED: Record<Permission, StaffRole[]> = {
  "products.manage": ["OWNER", "ADMIN"],
  "pricing.manage": ["OWNER", "ADMIN"],
  "releases.manage": ["OWNER", "ADMIN"],
  "content.manage": ["OWNER", "ADMIN"],
  "templates.manage": ["OWNER", "ADMIN"],
  "audit.view": ["OWNER", "ADMIN"],
  "licenses.manage": ["OWNER", "ADMIN", "SUPPORT"],
  "licenses.revoke": ["OWNER", "ADMIN"],
  "refunds.issue": ["OWNER", "FINANCE"],
  "coupons.manage": ["OWNER", "ADMIN", "FINANCE"],
  "tickets.manage": ["OWNER", "ADMIN", "SUPPORT"],
  "reports.view": ["OWNER", "ADMIN", "FINANCE"],
  "reports.export": ["OWNER", "FINANCE"],
  "customers.view": ALL,
  "orders.view": ALL,
  "staff.manage": ["OWNER"],
  "settings.manage": ["OWNER"],
  "customers.manage": ["OWNER", "ADMIN", "SUPPORT"],
  "payments.replay": ["OWNER", "ADMIN", "FINANCE"],
  "orders.resend_invoice": ALL,
  "renewals.remind": ["OWNER", "ADMIN", "SUPPORT"],
  "leads.view": ["OWNER", "ADMIN", "SUPPORT"],
};

describe("staff roles", () => {
  it("match the Prisma StaffRole enum and the prototype labels", () => {
    expect([...STAFF_ROLES].sort()).toEqual(Object.values(StaffRole).sort());
    expect(STAFF_ROLE_LABELS).toEqual({ OWNER: "Owner", ADMIN: "Administrator", SUPPORT: "Support", FINANCE: "Finance" });
  });
});

describe("PERMS", () => {
  it("defines exactly the expected permissions", () => {
    expect([...PERMISSIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
    expect(PERMISSIONS).toHaveLength(22);
    expect(Object.keys(PERMS)).toEqual(PERMISSIONS);
    for (const perm of PERMISSIONS) expect(new Set(PERMS[perm]).size).toBe(PERMS[perm].length);
  });

  const cases = PERMISSIONS.flatMap((perm) => STAFF_ROLES.map((role) => [perm, role] as const));
  it.each(cases)("%s for %s", (perm, role) => {
    const allowed = EXPECTED[perm].includes(role);
    expect(can(role, perm)).toBe(allowed);
    expect(rolesFor(perm).includes(role)).toBe(allowed);
    expect(permissionsFor(role).includes(perm)).toBe(allowed);
  });

  it("every permission includes the Owner", () => {
    for (const perm of PERMISSIONS) expect(can("OWNER", perm)).toBe(true);
  });

  it("grants nothing without a staff role", () => {
    for (const perm of PERMISSIONS) {
      expect(can(null, perm)).toBe(false);
      expect(can(undefined, perm)).toBe(false);
      expect(can("CUSTOMER" as StaffRole, perm)).toBe(false);
    }
    expect(permissionsFor(null)).toEqual([]);
  });

  it("per-role permission counts (prototype: Owner 17, Administrator 13, Support 4, Finance 6, plus the five additions)", () => {
    expect(permissionsFor("OWNER")).toHaveLength(22);
    expect(permissionsFor("ADMIN")).toHaveLength(18);
    expect(permissionsFor("SUPPORT")).toHaveLength(8);
    expect(permissionsFor("FINANCE")).toHaveLength(8);
  });

  it("Support cannot refund, revoke, change prices, view settings or audit", () => {
    for (const perm of ["refunds.issue", "licenses.revoke", "pricing.manage", "settings.manage", "audit.view"] as const) {
      expect(can("SUPPORT", perm)).toBe(false);
    }
    expect(canViewModule("SUPPORT", "settings")).toBe(false);
    expect(canViewModule("SUPPORT", "audit")).toBe(false);
  });

  it("leads: Owner, Administrator and Support read the Leads inbox; Finance does not", () => {
    expect(rolesFor("leads.view")).toEqual(["OWNER", "ADMIN", "SUPPORT"]);
    expect(canViewModule("SUPPORT", "leads")).toBe(true);
    expect(canViewModule("FINANCE", "leads")).toBe(false);
    expect(requiresLabel("leads.view")).toBe("Requires Owner / Administrator / Support");
  });

  it("Finance can refund but not revoke licenses", () => {
    expect(can("FINANCE", "refunds.issue")).toBe(true);
    expect(can("FINANCE", "licenses.revoke")).toBe(false);
    expect(can("FINANCE", "licenses.manage")).toBe(false);
  });

  it("recognises permission names", () => {
    expect(isPermission("refunds.issue")).toBe(true);
    expect(isPermission("refunds.issue ")).toBe(false);
    expect(isPermission("toString")).toBe(false);
    expect(isPermission("__proto__")).toBe(false);
  });
});

describe("permission copy", () => {
  it("uses the prototype tooltip and denial wording", () => {
    expect(requiresLabel("refunds.issue")).toBe("Requires Owner / Finance");
    expect(requiresLabel("licenses.manage")).toBe("Requires Owner / Administrator / Support");
    expect(exportNeedsLabel("reports.export")).toBe("Export needs Owner / Finance");
    expect(areaDeniedMessage("settings.manage", "SUPPORT")).toBe(
      "This area needs Owner access. You\u2019re signed in as Support. Ask the account owner if you need it.",
    );
    expect(areaDeniedMessage("audit.view", "FINANCE")).toBe(
      "This area needs Owner or Administrator access. You\u2019re signed in as Finance. Ask the account owner if you need it.",
    );
    expect(roleForbiddenMessage("SUPPORT")).toBe("Your role (Support) doesn\u2019t allow this.");
  });
});

describe("ADMIN_MODULES", () => {
  it("lists the sidebar in prototype order with labels, icons and groups (plus Leads after Tickets)", () => {
    expect(ADMIN_MODULES.map((m) => [m.key, m.label, m.icon, m.group])).toEqual([
      ["overview", "Overview", "space_dashboard", "DASHBOARD"],
      ["products", "Products", "inventory_2", "CATALOG"],
      ["plans", "Plans & pricing", "sell", "CATALOG"],
      ["releases", "Releases", "new_releases", "CATALOG"],
      ["orders", "Orders & payments", "receipt_long", "SALES"],
      ["customers", "Customers", "storefront", "SALES"],
      ["coupons", "Coupons", "confirmation_number", "SALES"],
      ["renewals", "Renewals", "autorenew", "SALES"],
      ["licenses", "Licenses", "key", "LICENSING"],
      ["tickets", "Tickets", "support_agent", "SUPPORT"],
      ["leads", "Leads", "contact_mail", "SUPPORT"],
      ["content", "Content & FAQs", "article", "CONTENT"],
      ["templates", "Templates", "mail", "CONTENT"],
      ["reports", "Reports", "monitoring", "INSIGHTS"],
      ["staff", "Staff & roles", "badge", "ADMINISTRATION"],
      ["audit", "Audit log", "policy", "ADMINISTRATION"],
      ["settings", "Settings", "settings", "ADMINISTRATION"],
    ]);
    expect(adminGroupTitle("DASHBOARD")).toBe("Dashboard");
  });

  it("gates modules with the prototype permissions", () => {
    const gates = Object.fromEntries(ADMIN_MODULES.map((m) => [m.key, m.viewPerm]));
    expect(gates).toEqual({
      overview: null,
      products: null,
      plans: null,
      releases: null,
      orders: "orders.view",
      customers: "customers.view",
      coupons: null,
      renewals: "customers.view",
      licenses: null,
      tickets: "tickets.manage",
      leads: "leads.view",
      content: "content.manage",
      templates: "templates.manage",
      reports: "reports.view",
      staff: "staff.manage",
      audit: "audit.view",
      settings: "settings.manage",
    });
  });

  it.each([
    ["OWNER", []],
    ["ADMIN", ["Staff & roles", "Settings"]],
    ["SUPPORT", ["Content & FAQs", "Templates", "Reports", "Staff & roles", "Audit log", "Settings"]],
    ["FINANCE", ["Tickets", "Leads", "Content & FAQs", "Templates", "Staff & roles", "Audit log", "Settings"]],
  ] as const)("locks the prototype module list for %s", (role, locked) => {
    expect(lockedModulesFor(role).map((m) => m.label)).toEqual(locked);
    for (const m of ADMIN_MODULES) expect(canViewModule(role, m.key)).toBe(!(locked as readonly string[]).includes(m.label));
  });

  it("shows nothing to someone without a staff role", () => {
    for (const m of ADMIN_MODULES) expect(canViewModule(null, m.key)).toBe(false);
  });
});

describe("DESTRUCTIVE_ACTIONS", () => {
  it("map to real permissions and always require a reason", () => {
    for (const rule of Object.values(DESTRUCTIVE_ACTIONS)) {
      expect(isPermission(rule.perm)).toBe(true);
      expect(rule.reason).toBe(true);
      expect(rule.label.length).toBeGreaterThan(0);
    }
  });

  it("require typed-ID confirmation only for refund, revoke and coupon delete", () => {
    const typed = Object.entries(DESTRUCTIVE_ACTIONS).filter(([, r]) => r.typedId).map(([k]) => k);
    expect(typed.sort()).toEqual(["coupons.delete", "licenses.revoke", "orders.refund"]);
  });

  it("use the expected permissions", () => {
    expect(DESTRUCTIVE_ACTIONS["orders.refund"].perm).toBe("refunds.issue");
    expect(DESTRUCTIVE_ACTIONS["licenses.revoke"].perm).toBe("licenses.revoke");
    expect(DESTRUCTIVE_ACTIONS["licenses.reset_devices"].perm).toBe("licenses.manage");
    expect(DESTRUCTIVE_ACTIONS["plans.archive"].perm).toBe("pricing.manage");
    expect(DESTRUCTIVE_ACTIONS["staff.change_role"].perm).toBe("staff.manage");
    // Deletes and revocations need a reason too (api-contracts section 7).
    expect(DESTRUCTIVE_ACTIONS["categories.delete"].perm).toBe("products.manage");
    expect(DESTRUCTIVE_ACTIONS["releases.delete"].perm).toBe("releases.manage");
    expect(DESTRUCTIVE_ACTIONS["releases.remove_installer"].perm).toBe("releases.manage");
    expect(DESTRUCTIVE_ACTIONS["staff.revoke_invite"].perm).toBe("staff.manage");
    expect(can("SUPPORT", DESTRUCTIVE_ACTIONS["orders.refund"].perm)).toBe(false);
    expect(can("FINANCE", DESTRUCTIVE_ACTIONS["orders.refund"].perm)).toBe(true);
  });
});

describe("validateReason", () => {
  it.each([undefined, null, "", "   ", "abc", "  ab  "])("rejects %j with the prototype copy", (input) => {
    expect(validateReason(input)).toEqual({ ok: false, message: "Add a short reason for the audit log." });
  });

  it("accepts four trimmed characters and returns the trimmed reason", () => {
    expect(validateReason("  dupe  ")).toEqual({ ok: true, reason: "dupe" });
    expect(validateReason("Customer asked for a refund")).toEqual({ ok: true, reason: "Customer asked for a refund" });
  });

  it("caps the length", () => {
    expect(validateReason("x".repeat(REASON_MAX_LENGTH)).ok).toBe(true);
    expect(validateReason("x".repeat(REASON_MAX_LENGTH + 1)).ok).toBe(false);
  });

  it("checks typed confirmations exactly", () => {
    expect(validateTypedConfirmation(" AX-10301 ", "AX-10301")).toEqual({ ok: true });
    expect(validateTypedConfirmation("ax-10301", "AX-10301")).toEqual({ ok: false, message: "Type AX-10301 exactly to confirm." });
    expect(validateTypedConfirmation(undefined, "LIC-24017").ok).toBe(false);
  });
});

describe("team roles", () => {
  const ALL_TEAM: TeamRole[] = ["OWNER", "BILLING", "TECHNICAL", "VIEWER"];
  const EXPECTED_TEAM: Record<TeamPermission, TeamRole[]> = {
    "licenses.view": ALL_TEAM,
    "invoices.view": ALL_TEAM,
    "tickets.view": ALL_TEAM,
    downloads: ["OWNER", "TECHNICAL"],
    "keys.reveal": ["OWNER", "TECHNICAL"],
    "devices.manage": ["OWNER", "TECHNICAL"],
    purchases: ["OWNER", "BILLING"],
    "billing.edit": ["OWNER", "BILLING"],
    "tickets.create": ["OWNER", "BILLING", "TECHNICAL"],
    "trials.start": ["OWNER", "BILLING", "TECHNICAL"],
    "team.manage": ["OWNER"],
    "activity.view": ["OWNER"],
  };

  it("match the Prisma TeamRole enum and the prototype labels", () => {
    expect([...TEAM_ROLES].sort()).toEqual(Object.values(TeamRole).sort());
    expect(TEAM_ROLE_META).toEqual({
      OWNER: { label: "Owner", description: "Everything, including team and billing." },
      BILLING: { label: "Billing admin", description: "Orders, invoices, renewals and billing details." },
      TECHNICAL: { label: "Technical contact", description: "Downloads, license keys, devices and tickets." },
      VIEWER: { label: "Viewer", description: "Read-only access to licenses and invoices." },
    });
  });

  it("defines exactly the expected team permissions", () => {
    expect([...TEAM_PERMISSIONS].sort()).toEqual(Object.keys(EXPECTED_TEAM).sort());
    expect(Object.keys(TEAM_PERMS)).toHaveLength(12);
  });

  const cases = TEAM_PERMISSIONS.flatMap((perm) => TEAM_ROLES.map((role) => [perm, role] as const));
  it.each(cases)("%s for %s", (perm, role) => {
    const allowed = EXPECTED_TEAM[perm].includes(role);
    expect(teamCan(role, perm)).toBe(allowed);
    expect(teamPermissionsFor(role).includes(perm)).toBe(allowed);
  });

  it("Viewer cannot reveal keys, deactivate devices or download", () => {
    expect(teamCan("VIEWER", "keys.reveal")).toBe(false);
    expect(teamCan("VIEWER", "devices.manage")).toBe(false);
    expect(teamCan("VIEWER", "downloads")).toBe(false);
    expect(teamCan("VIEWER", "tickets.create")).toBe(false);
    expect(teamCan("VIEWER", "tickets.view")).toBe(true);
  });

  it("follows decisions.md section 8", () => {
    expect(teamCan("TECHNICAL", "invoices.view")).toBe(true);
    expect(teamCan("TECHNICAL", "purchases")).toBe(false);
    expect(teamCan("BILLING", "purchases")).toBe(true);
    expect(teamCan("BILLING", "activity.view")).toBe(false);
    expect(teamCan("OWNER", "activity.view")).toBe(true);
  });

  it("grants nothing without a membership", () => {
    for (const perm of TEAM_PERMISSIONS) {
      expect(teamCan(null, perm)).toBe(false);
      expect(teamCan(undefined, perm)).toBe(false);
      expect(teamCan("ADMIN" as TeamRole, perm)).toBe(false);
    }
  });

  it("matrix rows reproduce the portal Team & access table", () => {
    // Copied from the prototype: [label, Owner, Billing admin, Technical contact, Viewer].
    const prototype: [string, number, number, number, number][] = [
      ["View licenses & invoices", 1, 1, 1, 1],
      ["Download software", 1, 0, 1, 0],
      ["Reveal license keys", 1, 0, 1, 0],
      ["Deactivate devices", 1, 0, 1, 0],
      ["Buy, renew and upgrade", 1, 1, 0, 0],
      ["Edit billing & GSTIN", 1, 1, 0, 0],
      ["Raise support tickets", 1, 1, 1, 0],
      ["Manage team & security", 1, 0, 0, 0],
    ];
    expect(TEAM_MATRIX_ROWS.map((r) => r.label)).toEqual(prototype.map((p) => p[0]));
    TEAM_MATRIX_ROWS.forEach((row, i) => {
      const cells = prototype[i]?.slice(1) ?? [];
      TEAM_ROLES.forEach((role, j) => {
        expect(teamMatrixAllows(role, row)).toBe(cells[j] === 1);
      });
    });
  });
});
