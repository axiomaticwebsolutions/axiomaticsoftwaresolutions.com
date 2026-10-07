/**
 * Pure helpers and copy of the team invitation page (/invite?token=; docs/decisions.md Phase 5 "Team"). The design
 * handoff has no invitation screen, so the page follows the auth pages (Account.dc.html) and all copy here is new
 * (owner review), except the API's own messages, which are shown as they arrive. Client-safe; unit tested in
 * tests/unit/team-ui-model.test.ts.
 */
import { MEMBER_NAME_MAX, TEAM_ERRORS } from "@/lib/validation/team";
import { isAcceptablePassword, PASSWORD_ERROR } from "@/lib/validation/password";
import { isLinkLikeName } from "@/lib/validation/names";

export const INVITE_PATH = "/invite";

/** Why an invitation cannot be used: the API's codes plus the page's own rate-limit and outage states. */
export type InviteProblemCode =
  | "invite_invalid"
  | "invite_expired"
  | "invite_revoked"
  | "invite_used"
  | "rate_limited"
  | "unavailable";

const PROBLEM_CODES: readonly InviteProblemCode[] = [
  "invite_invalid",
  "invite_expired",
  "invite_revoked",
  "invite_used",
  "rate_limited",
  "unavailable",
];

export function isInviteProblemCode(code: string): code is InviteProblemCode {
  return (PROBLEM_CODES as readonly string[]).includes(code);
}

/** API error codes that end the invitation flow (404 / 410 from preview or accept). */
export function isInviteGoneCode(code: string): boolean {
  return code === "invite_invalid" || code === "invite_expired" || code === "invite_revoked" || code === "invite_used";
}

export const INVITE_COPY = {
  title: (accountName: string) => `Join ${accountName}`,
  subtitle: (inviterName: string | null, roleLabel: string) =>
    inviterName
      ? `${inviterName} invited you to their team on Axiomatic as ${roleLabel}.`
      : `You\u2019ve been invited to a team on Axiomatic as ${roleLabel}.`,
  yourRole: "Your role",
  invitationFor: "Invitation for",
  expires: (date: string) => `Expires ${date}`,
  accept: "Accept invitation",
  signInToAccept: "Sign in to accept",
  forgot: "Forgot your password?",
  newAccount: "Choose your name and a password. You\u2019ll sign in with this email from now on.",
  fullName: "Full name",
  password: "Password",
  signIn: "Sign in",
  goToAccount: "Go to your account",
  home: "Go to the homepage",
  memberPre: "Already a member?",
  problems: {
    invite_invalid: "We can’t open this invitation",
    invite_expired: "Invitation expired",
    invite_revoked: "We can’t open this invitation",
    invite_used: "Invitation already accepted",
    rate_limited: "Too many attempts",
    unavailable: "We can’t load this invitation",
  } satisfies Record<InviteProblemCode, string>,
  unavailableMessage: "Please try again in a moment.",
} as const;

export function problemTitle(code: InviteProblemCode): string {
  return INVITE_COPY.problems[code];
}

export type ProblemAction = { label: string; href: string };

/**
 * The main way out of a problem state: an accepted invitation leads to the account (or sign-in); anything else to
 * the account when signed in, else the homepage.
 */
export function problemAction(code: InviteProblemCode, signedIn: boolean, accountHref: string): ProblemAction {
  if (signedIn) return { label: INVITE_COPY.goToAccount, href: accountHref };
  if (code === "invite_used") return { label: INVITE_COPY.signIn, href: "/sign-in" };
  return { label: INVITE_COPY.home, href: "/" };
}

/** The invitation page itself, for `next` after signing in. */
export function invitePath(token: string): string {
  return `${INVITE_PATH}?token=${encodeURIComponent(token)}`;
}

/** /sign-in?next=/invite?token=… : sign in as the invited email, then come back to accept. */
export function signInToAcceptHref(token: string): string {
  return `/sign-in?next=${encodeURIComponent(invitePath(token))}`;
}

export type NewMemberField = "name" | "password";
export const NEW_MEMBER_FIELDS: readonly NewMemberField[] = ["name", "password"];

/** Name and password checks of the new-person path, with the API's messages (lib/validation/team.ts). */
export function validateNewMember(values: Record<NewMemberField, string>): Partial<Record<NewMemberField, string>> {
  const out: Partial<Record<NewMemberField, string>> = {};
  const name = values.name.trim();
  if (name === "") out.name = TEAM_ERRORS.name;
  else if (name.length > MEMBER_NAME_MAX) out.name = TEAM_ERRORS.nameTooLong;
  else if (isLinkLikeName(name)) out.name = TEAM_ERRORS.nameLink;
  if (!isAcceptablePassword(values.password)) out.password = PASSWORD_ERROR;
  return out;
}
