/**
 * Copy and rules of the header account menu (components/store/account-menu.tsx). Pure and client-safe.
 */
import type { SessionUser } from "./session-store";

export const ACCOUNT_MENU_COPY = {
  signIn: "Sign in",
  myAccount: "My account",
  adminConsole: "Admin console",
  signOut: "Sign out",
  signedOut: "You’re signed out.",
  signedInAs: "Signed in as",
  /** Accessible name of the menu button; starts with the visible first name (WCAG 2.5.3). */
  menuLabel: (name: string) => `${name}, account menu`,
} as const;

/** The signed-in user's own area: the admin console for staff, the portal for customers. */
export function accountDestination(user: Pick<SessionUser, "kind">): { href: string; label: string } {
  return user.kind === "STAFF"
    ? { href: "/admin", label: ACCOUNT_MENU_COPY.adminConsole }
    : { href: "/account", label: ACCOUNT_MENU_COPY.myAccount };
}

/** Private areas a visitor cannot stay on after signing out (the menu then goes home). */
export function isPrivatePath(pathname: string): boolean {
  return /^\/(account|admin)(\/|$)/.test(pathname);
}

/** "Priya" from "Priya Sharma". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** "PS" from "Priya Sharma", "P" from "Priya", "?" when empty. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const picked = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts;
  const out = picked.map((p) => Array.from(p ?? "")[0] ?? "").join("").toUpperCase();
  return out || "?";
}
