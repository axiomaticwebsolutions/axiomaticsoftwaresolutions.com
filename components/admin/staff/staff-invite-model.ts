/**
 * Pure helpers and copy of the staff invitation page (/staff-invite?token=; decisions.md Phase 6 "Staff"). The handoff
 * has no screen for it, so it follows the team invitation page (/invite) in the auth layout; all copy here is new
 * (owner review) except the API messages, which are shown as they arrive. Client-safe; unit tested.
 */
import type { AuthAside } from "@/components/auth/auth-shell";
import { STAFF_ERRORS, STAFF_NAME_MAX } from "@/lib/admin/staff/model";
import { isLinkLikeName } from "@/lib/validation/names";
import { isAcceptablePassword, PASSWORD_ERROR } from "@/lib/validation/password";

export const STAFF_INVITE_PAGE = "/staff-invite";

/**
 * Brand panel of the staff invitation page (app/(staff-auth)/layout.tsx), in place of the customer-portal copy of the
 * other auth pages. New copy (owner review).
 */
export const STAFF_INVITE_ASIDE = {
  headline: "Run the storefront, licensing and support from one console.",
  bullets: [
    { icon: "inventory_2", text: "Products, plans and releases in one place" },
    { icon: "key", text: "Orders, licenses and renewals for every customer" },
    { icon: "policy", text: "Every change recorded in the audit log" },
  ],
} as const satisfies AuthAside;

export type StaffInviteProblemCode =
  | "invite_invalid"
  | "invite_expired"
  | "invite_revoked"
  | "invite_used"
  | "invite_changed"
  | "rate_limited"
  | "unavailable";

const PROBLEM_CODES: readonly StaffInviteProblemCode[] = [
  "invite_invalid",
  "invite_expired",
  "invite_revoked",
  "invite_used",
  "invite_changed",
  "rate_limited",
  "unavailable",
];

export function isStaffInviteProblemCode(code: string): code is StaffInviteProblemCode {
  return (PROBLEM_CODES as readonly string[]).includes(code);
}

/** API codes that end the flow (404 / 409 / 410 from preview or accept). */
export function isStaffInviteGoneCode(code: string): boolean {
  return code === "invite_invalid" || code === "invite_expired" || code === "invite_revoked" || code === "invite_used" || code === "invite_changed";
}

export const STAFF_INVITE_COPY = {
  title: "Join the admin console",
  subtitle: (inviterName: string | null, roleLabel: string) =>
    inviterName
      ? `${inviterName} invited you to the Axiomatic admin console as ${roleLabel}.`
      : `You\u2019ve been invited to the Axiomatic admin console as ${roleLabel}.`,
  yourRole: "Your role",
  invitationFor: "Invitation for",
  expires: (date: string) => `Expires ${date}`,
  intro: "Choose your name and a password. You\u2019ll sign in to the admin console with this email.",
  fullName: "Full name",
  password: "Password",
  accept: "Accept invitation",
  signIn: "Sign in",
  home: "Go to the homepage",
  goToAccount: "Go to your account",
  separate: "Staff accounts are separate from customer accounts, so this email can\u2019t also be used to buy software.",
  problems: {
    invite_invalid: "We can\u2019t open this invitation",
    invite_expired: "Invitation expired",
    invite_revoked: "We can\u2019t open this invitation",
    invite_used: "Invitation already accepted",
    invite_changed: "We can\u2019t open this invitation",
    rate_limited: "Too many attempts",
    unavailable: "We can\u2019t load this invitation",
  } satisfies Record<StaffInviteProblemCode, string>,
  unavailableMessage: "Please try again in a moment.",
} as const;

export function staffInviteProblemAction(code: StaffInviteProblemCode, signedInHref: string | null): { label: string; href: string } {
  if (signedInHref) return { label: STAFF_INVITE_COPY.goToAccount, href: signedInHref };
  if (code === "invite_used") return { label: STAFF_INVITE_COPY.signIn, href: "/sign-in" };
  return { label: STAFF_INVITE_COPY.home, href: "/" };
}

export type StaffInviteField = "name" | "password";
export const STAFF_INVITE_FIELDS: readonly StaffInviteField[] = ["name", "password"];

/** The API rules for name and password (lib/admin/staff/model.ts), checked before sending. */
export function validateStaffInvite(values: Record<StaffInviteField, string>): Partial<Record<StaffInviteField, string>> {
  const out: Partial<Record<StaffInviteField, string>> = {};
  const name = values.name.trim();
  if (name === "") out.name = STAFF_ERRORS.name;
  else if (name.length > STAFF_NAME_MAX) out.name = STAFF_ERRORS.nameTooLong;
  else if (isLinkLikeName(name)) out.name = STAFF_ERRORS.nameLink;
  if (!isAcceptablePassword(values.password)) out.password = PASSWORD_ERROR;
  return out;
}
