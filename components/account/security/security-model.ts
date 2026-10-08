/**
 * Pure helpers and copy behind the portal "Security" page (Customer Portal.dc.html vSecurity; decisions.md Phase 5
 * "Security page"): client-side checks with the API's own schemas, session labels and the confirmation copy. Lines
 * marked "new" cover what the prototype does not have (turning two-step off asks for the password, "Sign out all
 * others" asks for confirmation, the export is JSON). Client-safe; unit tested in tests/unit/team-ui-model.test.ts.
 */
import { relativeTime } from "@/components/account/portal-nav";
import type { IconName } from "@/components/icons/icon";
import type { SessionView } from "@/lib/auth/flows/me";
import { AUTH_FIELD_ERRORS } from "@/lib/validation/auth";
import { PASSWORD_ERROR, isAcceptablePassword } from "@/lib/validation/password";
import { profilePatchSchema } from "@/lib/validation/portal";

export type { SessionView };

export const SECURITY_COPY = {
  title: "Security",
  description: "Your profile, password, sign-in protection and active sessions.",
  profileHeading: "Your profile",
  fullName: "Full name",
  mobile: "Mobile",
  email: "Email",
  verified: "Verified",
  notVerified: "Not verified",
  saveProfile: "Save profile",
  profileSaved: "Profile saved",
  passwordHeading: "Password",
  current: "Current password",
  next: "New password",
  confirm: "Confirm new password",
  passwordNote: "Signs out other sessions",
  updatePassword: "Update password",
  passwordUpdated: "Password updated \u00b7 other sessions signed out",
  mismatch: "Passwords don\u2019t match.",
  twoStepHeading: "Two-step verification",
  twoStepBody: "Ask for a one-time code sent to your email when signing in from a new device.",
  /** new (decisions.md 2026-10-08; also in Admin > My profile): codes need working email, or the user is locked out. */
  twoStepEmailNote: "Codes are sent by email, so turn this on only once this site\u2019s emails reach you; otherwise you can\u2019t sign in.",
  twoStepOn: "Two-step verification on",
  twoStepOff: "Two-step verification off",
  /** new */
  twoStepOffTitle: "Turn off two-step verification?",
  /** new */
  twoStepOffBody: "We\u2019ll stop asking for a code when you sign in from a new device. Enter your password to confirm.",
  /** new */
  twoStepOffCta: "Turn off",
  dataHeading: "Account data",
  /** Prototype "…as CSV."; the export is a JSON file (decisions.md Phase 5). */
  dataBody: "Download licenses, orders and activity as JSON.",
  exportData: "Export data",
  exportFallbackName: "account-export.json",
  sessionsHeading: "Active sessions",
  signOutOthers: "Sign out all others",
  thisDevice: "This device",
  activeNow: "Active now",
  signOut: "Sign out",
  othersSignedOut: "Other sessions signed out",
  /** new */
  signOutOthersTitle: "Sign out all other sessions?",
  /** new */
  signOutOthersBody:
    "Every other browser and device signed in to your account will have to sign in again. This device stays signed in.",
} as const;

/** Sessions listed before "Show {n} more sessions" (new; long lists push the rest of the page away). */
export const SESSIONS_VISIBLE = 8;

/** new: "Show 3 more sessions" / "Show 1 more session". */
export function showMoreSessionsLabel(hidden: number): string {
  return `Show ${hidden} more ${hidden === 1 ? "session" : "sessions"}`;
}

/** "Exported account data to account-export-2026-10-07.json" (prototype export toast wording). */
export function exportedToast(fileName: string): string {
  return `Exported account data to ${fileName}`;
}

/** Prototype "Signed out Chrome on Windows". */
export function signedOutToast(device: string): string {
  return `Signed out ${device}`;
}

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

export type ProfileField = "name" | "phone";
export type ProfileValues = Record<ProfileField, string>;

/** PATCH /api/me checks on the client (same schema and messages as the API). */
export function validateProfile(values: ProfileValues): FieldErrors<ProfileField> {
  const parsed = profilePatchSchema.safeParse({ name: values.name, phone: values.phone });
  if (parsed.success) return {};
  const out: FieldErrors<ProfileField> = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if ((key === "name" || key === "phone") && !out[key]) out[key] = issue.message;
  }
  return out;
}

export type PasswordField = "current" | "next" | "confirm";
export type PasswordValues = Record<PasswordField, string>;
export const PASSWORD_FIELDS: readonly PasswordField[] = ["current", "next", "confirm"];

/**
 * "Enter your current password.", the password policy (decisions.md: "Use at least 8 characters with letters and a
 * number."; the prototype's "…including a number" predates it) and "Passwords don’t match.".
 */
export function validatePasswordChange(values: PasswordValues): FieldErrors<PasswordField> {
  const out: FieldErrors<PasswordField> = {};
  if (values.current === "") out.current = AUTH_FIELD_ERRORS.currentPassword;
  if (!isAcceptablePassword(values.next)) out.next = PASSWORD_ERROR;
  if (values.confirm !== values.next) out.confirm = SECURITY_COPY.mismatch;
  return out;
}

export function firstError<K extends string>(errors: FieldErrors<K>, order: readonly K[]): K | null {
  return order.find((key) => Boolean(errors[key])) ?? null;
}

/** smartphone for phones and tablets, computer otherwise (prototype). */
export function sessionIcon(session: Pick<SessionView, "mobile">): IconName {
  return session.mobile ? "smartphone" : "computer";
}

/**
 * Second line of a session row: the truncated IP (no GeoIP lookup, decisions.md) and "Active now" for this device
 * or "Last active {rel}", e.g. "103.21.4.x · Last active 3d ago".
 */
export function sessionMeta(session: Pick<SessionView, "current" | "ipPrefix" | "lastSeenAt">, now: Date): string {
  const when = session.current ? SECURITY_COPY.activeNow : `Last active ${relativeTime(new Date(session.lastSeenAt), now)}`;
  return session.ipPrefix ? `${session.ipPrefix} \u00b7 ${when}` : when;
}

/** Whether "Sign out all others" has anything to do. */
export function hasOtherSessions(sessions: readonly Pick<SessionView, "current">[]): boolean {
  return sessions.some((session) => !session.current);
}
