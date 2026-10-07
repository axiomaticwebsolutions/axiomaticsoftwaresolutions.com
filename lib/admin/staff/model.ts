/**
 * Staff & roles (Admin Console.dc.html `mods.staff`; decisions.md Phase 6 "Staff"): vocabulary, copy, list query, DTOs
 * and request schemas shared by the service, the API routes and the UI. Pure and client-safe.
 *
 * Rules: Owner only (staff.manage). Invitations are AuthToken STAFF_INVITE rows (7 days, single use, meta
 * { staffRole, invitedById }); the invitee is a STAFF user with staffStatus INVITED and no password until they accept
 * at /staff-invite. Owner and Finance always have two-step sign-in on. Nobody changes their own role or deactivates
 * themselves, and at least one active Owner always remains.
 */
import { z } from "zod";
import type { StaffRole } from "@/generated/prisma/enums";
import { formatAdminDateTimeLong } from "@/lib/admin/audit/format";
import type { ListQuerySpec } from "@/lib/admin/list-query";
import type { CsvColumn } from "@/lib/csv";
import { defineListState } from "@/lib/url-state";
import { PERMISSIONS, permissionsFor, requiresTwoStep, STAFF_ROLE_LABELS, STAFF_ROLES, type Permission } from "@/lib/rbac";
import { makeEmailSchema } from "@/lib/validation/contact";
import { isLinkLikeName, NAME_LINK_ERROR } from "@/lib/validation/names";
import { PASSWORD_ERROR, passwordSchema } from "@/lib/validation/password";

export const STAFF_INVITE_TTL_DAYS = 7;
export const STAFF_INVITE_PATH = "/staff-invite";
export const STAFF_INVITE_TEMPLATE = "staff_invite";
/** Where an accepted staff invitation continues. */
export const STAFF_HOME_PATH = "/admin";
export const STAFF_NAME_MAX = 120;
export const STAFF_INVITE_TOKEN_MAX = 256;

/** Roles that always sign in with two-step codes (decisions.md Phase 6); defined in lib/rbac.ts for the sign-in flow. */
export { requiresTwoStep, TWO_STEP_ROLES } from "@/lib/rbac";

export function roleLabel(role: StaffRole): string {
  return STAFF_ROLE_LABELS[role];
}

/** One line per role for the invite form (new copy, owner review). */
export const ROLE_SUMMARIES: Readonly<Record<StaffRole, string>> = {
  OWNER: "Everything, including staff, settings and refunds.",
  ADMIN: "Catalog, licenses, tickets, content and the audit log.",
  SUPPORT: "Customers, licenses, tickets and leads.",
  FINANCE: "Orders, refunds, coupons, reports and exports.",
};

/** "17 permissions" in the prototype's Change role rows (counted from lib/rbac.ts PERMS). */
export function permissionCountLabel(role: StaffRole): string {
  const n = permissionsFor(role).length;
  return `${n} ${n === 1 ? "permission" : "permissions"}`;
}

/** Role permissions matrix labels (prototype PL2, plus the permissions added since). */
export const PERMISSION_LABELS: Readonly<Record<Permission, string>> = {
  "products.manage": "Edit products & categories",
  "pricing.manage": "Change prices & plans",
  "releases.manage": "Publish releases",
  "customers.view": "View customers",
  "customers.manage": "Resend verification & password resets",
  "orders.view": "View orders & payments",
  "orders.resend_invoice": "Resend invoices",
  "refunds.issue": "Issue refunds",
  "payments.replay": "Replay payment webhooks",
  "licenses.manage": "Suspend, extend, reset",
  "licenses.revoke": "Revoke licenses",
  "renewals.remind": "Send renewal reminders",
  "coupons.manage": "Manage coupons",
  "tickets.manage": "Handle tickets",
  "leads.view": "View contact & demo requests",
  "content.manage": "Edit site content",
  "templates.manage": "Edit email templates",
  "reports.view": "View reports",
  "reports.export": "Export data",
  "staff.manage": "Manage staff",
  "audit.view": "View audit log",
  "settings.manage": "Business & integration settings",
};

/** Matrix rows in PERMS order. */
export const PERMISSION_ROWS: readonly { key: Permission; label: string }[] = PERMISSIONS.map((key) => ({
  key,
  label: PERMISSION_LABELS[key],
}));

// ---------- List ----------

export const STAFF_ROLE_FILTERS = ["owner", "admin", "support", "finance"] as const;
export const STAFF_STATUS_FILTERS = ["active", "invited", "deactivated"] as const;
export const STAFF_SORTS = ["name", "role", "status", "lastActive"] as const;
export type StaffSort = (typeof STAFF_SORTS)[number];
export type StaffRoleFilter = (typeof STAFF_ROLE_FILTERS)[number];
export type StaffStatusKey = (typeof STAFF_STATUS_FILTERS)[number];

export const STAFF_PAGE_SIZE = 25;

/** GET /api/admin/staff and the page: ?q=&filter[role]=&filter[status]=&sort=&page=&pageSize= */
export const STAFF_LIST_SPEC = {
  filters: { role: STAFF_ROLE_FILTERS, status: STAFF_STATUS_FILTERS },
  sortable: STAFF_SORTS,
  defaultSort: "role",
  defaultPageSize: STAFF_PAGE_SIZE,
} as const satisfies ListQuerySpec<{ role: typeof STAFF_ROLE_FILTERS; status: typeof STAFF_STATUS_FILTERS }, StaffSort>;

/** The same list state for the client table (lib/url-state, bracket filters like the API). */
export const STAFF_LIST_STATE = defineListState<"role" | "status">({
  filters: { role: { values: STAFF_ROLE_FILTERS }, status: { values: STAFF_STATUS_FILTERS } },
  sortable: STAFF_SORTS,
  defaultSort: { id: "role", desc: false },
  pageSize: STAFF_PAGE_SIZE,
  filterStyle: "bracket",
});

export const ROLE_FILTER_TO_ENUM: Readonly<Record<StaffRoleFilter, StaffRole>> = {
  owner: "OWNER",
  admin: "ADMIN",
  support: "SUPPORT",
  finance: "FINANCE",
};

export const STATUS_KEY_TO_ENUM = { active: "ACTIVE", invited: "INVITED", deactivated: "DEACTIVATED" } as const;

export function staffStatusKey(status: string | null | undefined): StaffStatusKey {
  const key = (status ?? "").toLowerCase();
  return key === "invited" || key === "deactivated" ? key : "active";
}

// ---------- DTOs ----------

/** The open invitation of an INVITED staff member (null: no working link, e.g. it expired or was never sent). */
export type StaffInviteInfo = { sentAt: string; expiresAt: string; expired: boolean };

/** One staff member as the list and the drawer show them (never the password hash or tokens). */
export type StaffRow = {
  id: string;
  /** "" while the invitation is pending. */
  name: string;
  email: string;
  role: StaffRole;
  status: StaffStatusKey;
  twoStepEnabled: boolean;
  lastActiveAt: string | null;
  createdAt: string;
  /** Latest invitation link of an invited member (null for everyone else, or when no link works). */
  invite: StaffInviteInfo | null;
};

/** "Vikram Rao", or the email while the invitation is pending. */
export function staffDisplayName(row: Pick<StaffRow, "name" | "email">): string {
  return row.name.trim() || row.email;
}

/** Whether this person signs in with two-step codes: their own setting, or always for Owner and Finance. */
export function twoStepOn(row: Pick<StaffRow, "twoStepEnabled" | "role">): boolean {
  return row.twoStepEnabled || requiresTwoStep(row.role);
}

/** Two-step cell and field: "On" or "Off" (Owner and Finance are always "On"; sign-in enforces it). */
export function twoStepLabel(row: Pick<StaffRow, "twoStepEnabled" | "role">): string {
  return twoStepOn(row) ? "On" : "Off";
}

/** Status badge text: Active, Invited, "Invite expired" (no working link) or Deactivated. */
export function staffStatusLabel(row: Pick<StaffRow, "status" | "invite">): string {
  if (row.status === "invited" && (!row.invite || row.invite.expired)) return "Invite expired";
  return row.status === "active" ? "Active" : row.status === "invited" ? "Invited" : "Deactivated";
}

// ---------- Requests ----------

export const STAFF_ERRORS = {
  email: "Enter a valid email address.",
  role: "Choose a role.",
  customerEmail:
    "This email belongs to a customer account. Staff and customer accounts are kept apart, so invite a different email address.",
  alreadyStaff: "This person is already a staff member.",
  alreadyInvited: "This person already has an invitation. Open their record to send it again.",
  deactivated: "This person\u2019s staff access is deactivated. Open their record to reactivate it.",
  ownRole: "You can\u2019t change your own role.",
  deactivateSelf: "You can\u2019t deactivate yourself.",
  lastOwner: "At least one active Owner must remain. Make someone else an Owner first.",
  notActive: "Only active staff can be deactivated. Revoke a pending invitation instead.",
  notDeactivated: "This person\u2019s access isn\u2019t deactivated.",
  notInvited: "This person has already accepted their invitation.",
  changed: "This staff member changed while you were working. Reload and try again.",
  name: "Enter your name.",
  nameTooLong: `Use ${STAFF_NAME_MAX} characters or fewer.`,
  nameLink: NAME_LINK_ERROR,
  password: PASSWORD_ERROR,
  token: "This invitation link isn\u2019t valid. Ask the account owner to send a new one.",
} as const;

export function sameRoleMessage(name: string, role: StaffRole): string {
  return `${name} is already ${roleLabel(role)}.`;
}

const roleSchema = z.enum(STAFF_ROLES, { message: STAFF_ERRORS.role });

/** POST /api/admin/staff { email, role }: the address is trimmed and lower-cased. */
export const inviteStaffSchema = z.strictObject({
  email: makeEmailSchema(STAFF_ERRORS.email),
  role: roleSchema,
});
export type InviteStaffInput = z.output<typeof inviteStaffSchema>;

/** The role part of PATCH /api/admin/staff/:id (the route adds the destructive reason fields). */
export const staffRoleField = roleSchema;

export const staffInviteTokenSchema = z
  .string({ error: STAFF_ERRORS.token })
  .min(1, { message: STAFF_ERRORS.token })
  .max(STAFF_INVITE_TOKEN_MAX, { message: STAFF_ERRORS.token });

export const staffNameSchema = z
  .string({ error: STAFF_ERRORS.name })
  .trim()
  .min(1, { message: STAFF_ERRORS.name })
  .max(STAFF_NAME_MAX, { message: STAFF_ERRORS.nameTooLong })
  .refine((value) => !isLinkLikeName(value), { message: STAFF_ERRORS.nameLink });

/** POST /api/staff-invites/accept { token, name, password }. */
export const acceptStaffInviteSchema = z.strictObject({
  token: staffInviteTokenSchema,
  name: staffNameSchema,
  password: passwordSchema,
});
export type AcceptStaffInviteInput = z.output<typeof acceptStaffInviteSchema>;

// ---------- CSV ----------

/** GET /api/admin/staff/export.csv: one row per staff member matching the list filters (never secrets). */
export const STAFF_CSV_COLUMNS: readonly CsvColumn<StaffRow>[] = [
  { header: "Name", value: (r) => r.name },
  { header: "Email", value: (r) => r.email },
  { header: "Role", value: (r) => roleLabel(r.role) },
  { header: "Status", value: (r) => staffStatusLabel(r) },
  { header: "Two-step sign-in", value: (r) => twoStepLabel(r) },
  { header: "Last active (IST)", value: (r) => (r.lastActiveAt ? formatAdminDateTimeLong(r.lastActiveAt) : "") },
  { header: "Added (IST)", value: (r) => formatAdminDateTimeLong(r.createdAt) },
];

export const STAFF_EXPORT_FILE = "staff";

/** Audit detail of a staff export: the filters in words ("role: Support · status: invited · search: rao"). */
export function staffExportDetail(query: { q: string; filters: { role?: StaffRoleFilter; status?: StaffStatusKey } }): string | null {
  const parts = [
    query.filters.role ? `role: ${roleLabel(ROLE_FILTER_TO_ENUM[query.filters.role])}` : null,
    query.filters.status ? `status: ${query.filters.status}` : null,
    query.q ? `search: ${query.q}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" \u00B7 ") : null;
}

// ---------- UI copy (prototype mods.staff; new copy marked for owner review in the report) ----------

export const STAFF_COPY = {
  caption: "Staff accounts",
  searchPlaceholder: "Search staff by name or email",
  searchLabel: "Search staff",
  invite: "Invite staff",
  invitationPending: "Invitation pending",
  columns: { name: "Name", role: "Role", status: "Status", twoStep: "2-step", lastActive: "Last active" },
  drawerKind: "Staff",
  fields: {
    role: "Role",
    status: "Status",
    twoStep: "Two-step verification",
    lastActive: "Last active",
    added: "Added",
    invitation: "Invitation",
  },
  changeRole: "Change role",
  current: "Current",
  assign: "Assign",
  roleTitle: (name: string, role: string) => `Make ${name} ${role}?`,
  roleConsequence: "Their access changes on their next request.",
  roleTwoStepNote: "Owner and Finance always sign in with an emailed code, so two-step sign-in will be turned on.",
  roleUpdated: "Role updated",
  ownRecord: "This is you. Another Owner can change your role or access.",
  notFound: "This staff member doesn’t exist. They may have been removed.",
  deactivateTitle: (name: string) => `Deactivate ${name}?`,
  reactivateTitle: (name: string) => `Reactivate ${name}?`,
  deactivateConsequence: "Deactivation signs them out everywhere immediately.",
  reactivateConsequence: "They can sign in again with their existing password.",
  staffUpdated: "Staff updated",
  invitationSection: "Invitation",
  inviteSent: (date: string) => `Sent ${date}`,
  inviteExpires: (date: string) => `Expires ${date}`,
  inviteExpired: (date: string) => `Expired ${date}`,
  noWorkingLink: "No working link. Send the invitation again.",
  resend: "Resend invitation",
  resent: (email: string) => `Invitation sent again to ${email}`,
  revoke: "Revoke invitation",
  revokeTitle: (email: string) => `Revoke the invitation for ${email}?`,
  revokeConsequence: "The link stops working and the pending staff record is removed. You can invite them again later.",
  revoked: "Invitation revoked",
  permissionsTitle: "Role permissions",
  permissionsDescription: "Enforced on the server for every request. Changing roles is limited to the Owner.",
  permissionColumn: "Permission",
  allowedFor: (role: string) => `Allowed for ${role}`,
  notAllowedFor: (role: string) => `Not allowed for ${role}`,
  inviteTitle: "Invite staff",
  inviteDescription:
    "They\u2019ll get an email with a link to choose their name and password. The link works for 7 days.",
  email: "Work email",
  emailPlaceholder: "name@axiomatic.example",
  role: "Role",
  sendInvite: "Send invitation",
  cancel: "Cancel",
  invited: (email: string) => `Invitation sent to ${email}`,
  exported: (rows: number, file: string) => `Exported ${rows} ${rows === 1 ? "row" : "rows"} to ${file}`,
} as const;
