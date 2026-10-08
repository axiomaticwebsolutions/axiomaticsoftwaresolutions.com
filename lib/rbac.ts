/**
 * Single source of truth for authorisation, used by both the UI (cosmetic hiding) and every API route
 * (enforcement). Staff permissions: docs/decisions.md section 7 plus `leads.view` (Phase 6). Customer team
 * permissions: section 8 and the portal "Team & access" matrix. Admin records (2026-10-08): customers.create, customers.edit
 * and customers.verify_email for Owner, Administrator and Support; orders.create, orders.edit, payments.record_offline and
 * invoices.correct for Owner and Finance. Pure and client-safe.
 */
import type { IconSourceName } from "@/components/icons/icon-names";
import type { StaffRole, TeamRole } from "@/generated/prisma/enums";

// ---------- Staff roles and permissions ----------

export const STAFF_ROLES = ["OWNER", "ADMIN", "SUPPORT", "FINANCE"] as const satisfies readonly StaffRole[];

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  OWNER: "Owner",
  ADMIN: "Administrator",
  SUPPORT: "Support",
  FINANCE: "Finance",
};

/** Permission -> roles that hold it. Order matters only for display ("Requires Owner / Finance"). */
export const PERMS = {
  "products.manage": ["OWNER", "ADMIN"],
  "pricing.manage": ["OWNER", "ADMIN"],
  "releases.manage": ["OWNER", "ADMIN"],
  "customers.view": ["OWNER", "ADMIN", "SUPPORT", "FINANCE"],
  "customers.manage": ["OWNER", "ADMIN", "SUPPORT"],
  "customers.create": ["OWNER", "ADMIN", "SUPPORT"],
  "customers.edit": ["OWNER", "ADMIN", "SUPPORT"],
  "customers.verify_email": ["OWNER", "ADMIN", "SUPPORT"],
  "orders.view": ["OWNER", "ADMIN", "SUPPORT", "FINANCE"],
  "orders.resend_invoice": ["OWNER", "ADMIN", "SUPPORT", "FINANCE"],
  "orders.create": ["OWNER", "FINANCE"],
  "orders.edit": ["OWNER", "FINANCE"],
  "payments.record_offline": ["OWNER", "FINANCE"],
  "invoices.correct": ["OWNER", "FINANCE"],
  "refunds.issue": ["OWNER", "FINANCE"],
  "payments.replay": ["OWNER", "ADMIN", "FINANCE"],
  "licenses.manage": ["OWNER", "ADMIN", "SUPPORT"],
  "licenses.revoke": ["OWNER", "ADMIN"],
  "renewals.remind": ["OWNER", "ADMIN", "SUPPORT"],
  "coupons.manage": ["OWNER", "ADMIN", "FINANCE"],
  "tickets.manage": ["OWNER", "ADMIN", "SUPPORT"],
  "leads.view": ["OWNER", "ADMIN", "SUPPORT"],
  "content.manage": ["OWNER", "ADMIN"],
  "templates.manage": ["OWNER", "ADMIN"],
  "reports.view": ["OWNER", "ADMIN", "FINANCE"],
  "reports.export": ["OWNER", "FINANCE"],
  "staff.manage": ["OWNER"],
  "audit.view": ["OWNER", "ADMIN"],
  "settings.manage": ["OWNER"],
} as const satisfies Record<string, readonly StaffRole[]>;

export type Permission = keyof typeof PERMS;

export const PERMISSIONS = Object.keys(PERMS) as Permission[];

export function isPermission(value: string): value is Permission {
  return Object.prototype.hasOwnProperty.call(PERMS, value);
}

export function isStaffRole(value: unknown): value is StaffRole {
  return typeof value === "string" && (STAFF_ROLES as readonly string[]).includes(value);
}

/** Server-side check for every admin route and action. A missing role (customer, signed out) is never allowed. */
export function can(role: StaffRole | null | undefined, perm: Permission): boolean {
  if (!isStaffRole(role)) return false;
  const roles: readonly StaffRole[] = PERMS[perm];
  return roles.includes(role);
}

export function rolesFor(perm: Permission): StaffRole[] {
  return [...PERMS[perm]];
}

export function permissionsFor(role: StaffRole | null | undefined): Permission[] {
  return PERMISSIONS.filter((perm) => can(role, perm));
}

function roleLabels(perm: Permission): string[] {
  return rolesFor(perm).map((r) => STAFF_ROLE_LABELS[r]);
}

/** Tooltip on a disabled action: "Requires Owner / Finance". */
export function requiresLabel(perm: Permission): string {
  return `Requires ${roleLabels(perm).join(" / ")}`;
}

/** Tooltip on a disabled export button: "Export needs Owner / Finance". */
export function exportNeedsLabel(perm: Permission): string {
  return `Export needs ${roleLabels(perm).join(" / ")}`;
}

/** Denied-page copy for a module the role cannot open. */
export function areaDeniedMessage(perm: Permission, role: StaffRole): string {
  return `This area needs ${roleLabels(perm).join(" or ")} access. You\u2019re signed in as ${STAFF_ROLE_LABELS[role]}. Ask the account owner if you need it.`;
}

/** API error copy for a 403 on a staff action. */
export function roleForbiddenMessage(role: StaffRole): string {
  return `Your role (${STAFF_ROLE_LABELS[role]}) doesn\u2019t allow this.`;
}

export const NOT_ALLOWED_FOR_ROLE = "Not allowed for your role";
export const READ_ONLY_FOR_ROLE = "Read only for your role";

// ---------- Admin console modules ----------

export const ADMIN_MODULE_GROUPS = [
  "DASHBOARD",
  "CATALOG",
  "SALES",
  "LICENSING",
  "SUPPORT",
  "CONTENT",
  "INSIGHTS",
  "ADMINISTRATION",
] as const;

export type AdminModuleGroup = (typeof ADMIN_MODULE_GROUPS)[number];

export type AdminModule = {
  key: string;
  /** Sidebar label (prototype `nav || title`). */
  label: string;
  /** Page heading. */
  title: string;
  description: string;
  /** Material Symbols name (checked against the icon registry). */
  icon: IconSourceName;
  /** Permission needed to open the module; null = any staff role. */
  viewPerm: Permission | null;
  group: AdminModuleGroup;
};

/**
 * Sidebar order, labels, icons and gates as in the Admin Console prototype, plus the Leads inbox (contact and demo
 * requests; not in the prototype, decisions.md Phase 6) after Tickets. Tickets need tickets.manage (Finance has no
 * ticket access; the prototype showed Finance a read-only list).
 */
export const ADMIN_MODULES = [
  { key: "overview", label: "Overview", title: "Overview", icon: "space_dashboard", viewPerm: null, group: "DASHBOARD",
    description: "Sales, payments, licensing and support at a glance." },
  { key: "products", label: "Products", title: "Products & categories", icon: "inventory_2", viewPerm: null, group: "CATALOG",
    description: "Software listed on the storefront. Categories and products are data-driven, so new ones appear on the site without code changes." },
  { key: "plans", label: "Plans & pricing", title: "Plans & license policies", icon: "sell", viewPerm: null, group: "CATALOG",
    description: "Prices (excluding GST), terms and device limits per plan. Each product only offers the license types configured here." },
  { key: "releases", label: "Releases", title: "Software releases", icon: "new_releases", viewPerm: null, group: "CATALOG",
    description: "Installers, supported platforms and release notes. Files live in private storage; customers get signed links only after an entitlement check." },
  { key: "orders", label: "Orders & payments", title: "Orders, payments & refunds", icon: "receipt_long", viewPerm: "orders.view", group: "SALES",
    description: "Orders are marked paid after a verified payment webhook, or when Owner or Finance record an offline payment. Refunds revoke the licenses they issued." },
  { key: "customers", label: "Customers", title: "Customers & business accounts", icon: "storefront", viewPerm: "customers.view", group: "SALES",
    description: "Businesses that have bought or trialled software. Staff can add customers, fix their details and confirm emails. Guest purchases link to an account by email." },
  { key: "coupons", label: "Coupons", title: "Coupons & promotions", icon: "confirmation_number", viewPerm: null, group: "SALES",
    description: "Codes are validated on the server at checkout against dates, limits and eligible products." },
  { key: "renewals", label: "Renewals", title: "Renewals & maintenance", icon: "autorenew", viewPerm: "customers.view", group: "SALES",
    description: "Licenses ending in the next 60 days or ended in the last 30. Reminder emails go out automatically at 30 and 7 days." },
  { key: "licenses", label: "Licenses", title: "Licenses", icon: "key", viewPerm: null, group: "LICENSING",
    description: "Issue, extend, suspend, reset and revoke licenses. Keys are masked; full keys are never shown in the console or logs." },
  { key: "tickets", label: "Tickets", title: "Support tickets", icon: "support_agent", viewPerm: "tickets.manage", group: "SUPPORT",
    description: "Customer conversations, priorities and assignments." },
  { key: "leads", label: "Leads", title: "Contact & demo requests", icon: "contact_mail", viewPerm: "leads.view", group: "SUPPORT",
    description: "Requests sent from the website’s contact and demo forms. Each sender gets an automatic acknowledgement email." },
  { key: "content", label: "Content & FAQs", title: "Website content & FAQs", icon: "article", viewPerm: "content.manage", group: "CONTENT",
    description: "FAQs and announcements shown on the storefront." },
  { key: "templates", label: "Templates", title: "Notification templates", icon: "mail", viewPerm: "templates.manage", group: "CONTENT",
    description: "Transactional emails. Variables in double braces are filled at send time." },
  { key: "reports", label: "Reports", title: "Reports & exports", icon: "monitoring", viewPerm: "reports.view", group: "INSIGHTS",
    description: "Download data for accounting and analysis. Exports are logged." },
  { key: "staff", label: "Staff & roles", title: "Staff accounts, roles & permissions", icon: "badge", viewPerm: "staff.manage", group: "ADMINISTRATION",
    description: "Staff sign in with their own accounts. Owner, Administrator, Support and Finance roles control what each person can do." },
  { key: "audit", label: "Audit log", title: "Audit log", icon: "policy", viewPerm: "audit.view", group: "ADMINISTRATION",
    description: "Append-only record of administrative and system actions. Secrets, full keys and payment details are never logged." },
  { key: "settings", label: "Settings", title: "Business & integration settings", icon: "settings", viewPerm: "settings.manage", group: "ADMINISTRATION",
    description: "Company details, tax and invoicing, licensing policy and integrations. Secrets live in environment variables and are never shown here." },
] as const satisfies readonly AdminModule[];

export type AdminModuleKey = (typeof ADMIN_MODULES)[number]["key"];

export function isAdminModuleKey(value: string): value is AdminModuleKey {
  return ADMIN_MODULES.some((m) => m.key === value);
}

export function adminModule(key: AdminModuleKey): AdminModule {
  const found = ADMIN_MODULES.find((m) => m.key === key);
  if (!found) throw new RangeError(`Unknown admin module ${key}`);
  return found;
}

/** Breadcrumb form of a sidebar group: "DASHBOARD" -> "Dashboard". */
export function adminGroupTitle(group: AdminModuleGroup): string {
  return group.charAt(0) + group.slice(1).toLowerCase();
}

export function canViewModule(role: StaffRole | null | undefined, key: AdminModuleKey): boolean {
  if (!isStaffRole(role)) return false;
  const perm = adminModule(key).viewPerm;
  return perm === null || can(role, perm);
}

/** Modules shown with a lock icon for this role, in sidebar order. */
export function lockedModulesFor(role: StaffRole): AdminModule[] {
  return ADMIN_MODULES.filter((m) => !canViewModule(role, m.key));
}

// ---------- Destructive actions ----------

export type DestructiveActionRule = {
  perm: Permission;
  /** A reason of at least REASON_MIN_LENGTH characters is required and saved to the audit log. */
  reason: boolean;
  /** The user must type the target id (order id, license id, coupon code) to confirm. */
  typedId: boolean;
  /** Confirm button label. */
  label: string;
};

export const DESTRUCTIVE_ACTIONS = {
  "orders.refund": { perm: "refunds.issue", reason: true, typedId: true, label: "Issue refund" },
  "licenses.revoke": { perm: "licenses.revoke", reason: true, typedId: true, label: "Revoke license" },
  "licenses.suspend": { perm: "licenses.manage", reason: true, typedId: false, label: "Suspend" },
  "licenses.reinstate": { perm: "licenses.manage", reason: true, typedId: false, label: "Reinstate" },
  "licenses.extend": { perm: "licenses.manage", reason: true, typedId: false, label: "Extend" },
  "licenses.reset_devices": { perm: "licenses.manage", reason: true, typedId: false, label: "Reset devices" },
  "licenses.deactivate_device": { perm: "licenses.manage", reason: true, typedId: false, label: "Deactivate" },
  "licenses.issue_manual": { perm: "licenses.manage", reason: true, typedId: false, label: "Issue license" },
  "plans.archive": { perm: "pricing.manage", reason: true, typedId: false, label: "Archive" },
  "plans.restore": { perm: "pricing.manage", reason: true, typedId: false, label: "Restore" },
  "products.hide": { perm: "products.manage", reason: true, typedId: false, label: "Hide" },
  "products.publish": { perm: "products.manage", reason: true, typedId: false, label: "Publish" },
  "categories.delete": { perm: "products.manage", reason: true, typedId: false, label: "Delete category" },
  "releases.delete": { perm: "releases.manage", reason: true, typedId: false, label: "Delete draft" },
  "releases.remove_installer": { perm: "releases.manage", reason: true, typedId: false, label: "Remove installer" },
  "coupons.delete": { perm: "coupons.manage", reason: true, typedId: true, label: "Delete coupon" },
  "faqs.delete": { perm: "content.manage", reason: true, typedId: false, label: "Delete" },
  "staff.change_role": { perm: "staff.manage", reason: true, typedId: false, label: "Change role" },
  "staff.deactivate": { perm: "staff.manage", reason: true, typedId: false, label: "Deactivate" },
  "staff.reactivate": { perm: "staff.manage", reason: true, typedId: false, label: "Reactivate" },
  "staff.revoke_invite": { perm: "staff.manage", reason: true, typedId: false, label: "Revoke invitation" },
  "customers.verify_email": { perm: "customers.verify_email", reason: true, typedId: false, label: "Mark verified" },
  "customers.set_password_link": { perm: "customers.manage", reason: true, typedId: false, label: "Create link" },
  "orders.cancel": { perm: "orders.edit", reason: true, typedId: false, label: "Cancel order" },
} as const satisfies Record<string, DestructiveActionRule>;

export type DestructiveActionKey = keyof typeof DESTRUCTIVE_ACTIONS;

export const REASON_MIN_LENGTH = 4;
/** Keeps audit rows bounded; the prototype sets no upper limit. */
export const REASON_MAX_LENGTH = 500;
export const REASON_REQUIRED_MESSAGE = "Add a short reason for the audit log.";
export const REASON_TOO_LONG_MESSAGE = `Keep the reason to ${REASON_MAX_LENGTH} characters or fewer.`;

export function validateReason(
  input: string | null | undefined,
): { ok: true; reason: string } | { ok: false; message: string } {
  const reason = (input ?? "").trim();
  if (reason.length < REASON_MIN_LENGTH) return { ok: false, message: REASON_REQUIRED_MESSAGE };
  if (reason.length > REASON_MAX_LENGTH) return { ok: false, message: REASON_TOO_LONG_MESSAGE };
  return { ok: true, reason };
}

/** Typed-ID confirmation (refund, revoke, coupon delete): the trimmed input must equal the id exactly. */
export function validateTypedConfirmation(
  input: string | null | undefined,
  expected: string,
): { ok: true } | { ok: false; message: string } {
  if ((input ?? "").trim() === expected) return { ok: true };
  return { ok: false, message: `Type ${expected} exactly to confirm.` };
}

// ---------- Customer team roles (portal "Team & access") ----------

export const TEAM_ROLES = ["OWNER", "BILLING", "TECHNICAL", "VIEWER"] as const satisfies readonly TeamRole[];

export const TEAM_ROLE_META: Record<TeamRole, { label: string; description: string }> = {
  OWNER: { label: "Owner", description: "Everything, including team and billing." },
  BILLING: { label: "Billing admin", description: "Orders, invoices, renewals and billing details." },
  TECHNICAL: { label: "Technical contact", description: "Downloads, license keys, devices and tickets." },
  VIEWER: { label: "Viewer", description: "Read-only access to licenses and invoices." },
};

export const TEAM_PERMS = {
  "licenses.view": ["OWNER", "BILLING", "TECHNICAL", "VIEWER"],
  "invoices.view": ["OWNER", "BILLING", "TECHNICAL", "VIEWER"],
  "tickets.view": ["OWNER", "BILLING", "TECHNICAL", "VIEWER"],
  downloads: ["OWNER", "TECHNICAL"],
  "keys.reveal": ["OWNER", "TECHNICAL"],
  "devices.manage": ["OWNER", "TECHNICAL"],
  purchases: ["OWNER", "BILLING"],
  "billing.edit": ["OWNER", "BILLING"],
  "tickets.create": ["OWNER", "BILLING", "TECHNICAL"],
  "trials.start": ["OWNER", "BILLING", "TECHNICAL"],
  "team.manage": ["OWNER"],
  "activity.view": ["OWNER"],
} as const satisfies Record<string, readonly TeamRole[]>;

export type TeamPermission = keyof typeof TEAM_PERMS;

export const TEAM_PERMISSIONS = Object.keys(TEAM_PERMS) as TeamPermission[];

export function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === "string" && (TEAM_ROLES as readonly string[]).includes(value);
}

/** Server-side check for every account-scoped route. No membership (null) is never allowed. */
export function teamCan(role: TeamRole | null | undefined, perm: TeamPermission): boolean {
  if (!isTeamRole(role)) return false;
  const roles: readonly TeamRole[] = TEAM_PERMS[perm];
  return roles.includes(role);
}

export function teamRolesFor(perm: TeamPermission): TeamRole[] {
  return [...TEAM_PERMS[perm]];
}

export function teamPermissionsFor(role: TeamRole | null | undefined): TeamPermission[] {
  return TEAM_PERMISSIONS.filter((perm) => teamCan(role, perm));
}

/** Rows of the portal "Team & access" matrix, in order. A cell is allowed when the role holds every permission. */
export const TEAM_MATRIX_ROWS = [
  { label: "View licenses & invoices", perms: ["licenses.view", "invoices.view"] },
  { label: "Download software", perms: ["downloads"] },
  { label: "Reveal license keys", perms: ["keys.reveal"] },
  { label: "Deactivate devices", perms: ["devices.manage"] },
  { label: "Buy, renew and upgrade", perms: ["purchases"] },
  { label: "Edit billing & GSTIN", perms: ["billing.edit"] },
  { label: "Raise support tickets", perms: ["tickets.create"] },
  { label: "Manage team & security", perms: ["team.manage"] },
] as const satisfies readonly { label: string; perms: readonly TeamPermission[] }[];

export function teamMatrixAllows(role: TeamRole, row: { perms: readonly TeamPermission[] }): boolean {
  return row.perms.every((perm) => teamCan(role, perm));
}
