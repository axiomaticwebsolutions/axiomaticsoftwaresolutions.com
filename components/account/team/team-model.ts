/**
 * Pure helpers and copy behind "Team & access" (Customer Portal.dc.html vTeam; docs/decisions.md Phase 5 "Team"):
 * member labels, status badges, role choices, the confirmation dialogs and the permission matrix (TEAM_MATRIX_ROWS).
 * Copy is the prototype's; lines marked "new" cover states the prototype does not have (role-change confirmation,
 * resend, expired links). Client-safe; unit tested in tests/unit/team-ui-model.test.ts.
 */
import type { TeamRole } from "@/generated/prisma/enums";
import { initialsOf, relativeTime } from "@/components/account/portal-nav";
import type { TeamMemberView, TeamView } from "@/lib/portal/team";
import { TEAM_MATRIX_ROWS, TEAM_ROLE_META, TEAM_ROLES, teamMatrixAllows } from "@/lib/rbac";
import { DEFAULT_INVITE_ROLE, INVITE_ROLES, INVITE_TTL_DAYS, inviteMemberSchema, type InviteRole } from "@/lib/validation/team";

export type { TeamMemberView, TeamView };

export type BadgeTone = "lavender" | "sage" | "peach" | "pink" | "slate" | "blue";

export const TEAM_COPY = {
  title: "Team & access",
  description: "Give staff and your accountant their own sign-in with only the access they need.",
  invite: "Invite member",
  membersHeading: "Members",
  membersNote: "Each member signs in with their own email",
  pending: "Invitation pending",
  you: "You",
  active: "Active",
  /** new: the invitation link no longer works (expired or never sent). */
  inviteExpired: "Invite expired",
  /** new */
  resend: "Resend",
  remove: "Remove",
  revoke: "Revoke invite",
  roleUpdated: "Role updated",
  accessRemoved: "Access removed",
  invitationSent: (email: string) => `Invitation sent to ${email}`,
  /** new: the invite / resend API answered `emailSent: false` (the invitation exists; its email failed). */
  invitationEmailFailed: "Invitation created, but the email couldn\u2019t be sent. Use Resend.",
  matrixHeading: "What each role can do",
  permission: "Permission",
  inviteTitle: "Invite member",
  /** new */
  inviteDescription: (business: string) =>
    `They\u2019ll get an email with a link to join ${business}. The link works for ${INVITE_TTL_DAYS} days.`,
  email: "Work email",
  emailPlaceholder: "name@business.com",
  role: "Role",
  cancel: "Cancel",
  sendInvite: "Send invite",
  /** new */
  changeRole: "Change role",
} as const;

/** Column headings of the members table (shown upper-case, as in the prototype). */
export const MEMBER_COLUMNS = {
  member: "Member",
  role: "Role",
  status: "Status",
  lastActive: "Last active",
  actions: "Actions",
} as const;

/** "3 active · 1 invited" after "Members ·". */
export function membersSummary(counts: TeamView["counts"]): string {
  return `${counts.active} active \u00b7 ${counts.invited} invited`;
}

/** Name in the table: the person's name, or "Invitation pending" while an invited placeholder has none. */
export function memberTitle(member: Pick<TeamMemberView, "name">): string {
  return member.name.trim() || TEAM_COPY.pending;
}

/** Name in dialogs and toasts: the person's name, else their email. */
export function memberLabel(member: Pick<TeamMemberView, "name" | "email">): string {
  return member.name.trim() || member.email;
}

export type MemberAvatar = { text: string; tone: "lavender" | "slate" };

/** 32px avatar: initials (lavender), or "@" for an invitation (slate). */
export function memberAvatar(member: Pick<TeamMemberView, "name" | "email" | "status">): MemberAvatar {
  if (member.status === "invited") return { text: "@", tone: "slate" };
  return { text: initialsOf(member.name.trim() || member.email), tone: "lavender" };
}

export type MemberBadge = { label: string; tone: BadgeTone };

/** Status pill: "Invited 3d ago" (peach), "Invite expired" (peach), "You" (lavender), "Active" (sage). */
export function memberStatusBadge(
  member: Pick<TeamMemberView, "status" | "you" | "invitedAt" | "inviteExpired">,
  now: Date,
): MemberBadge {
  if (member.status === "invited") {
    if (member.inviteExpired) return { label: TEAM_COPY.inviteExpired, tone: "peach" };
    return { label: member.invitedAt ? `Invited ${relativeTime(new Date(member.invitedAt), now)}` : "Invited", tone: "peach" };
  }
  if (member.you) return { label: TEAM_COPY.you, tone: "lavender" };
  return { label: TEAM_COPY.active, tone: "sage" };
}

/** "2d ago", "just now", or "—" (never signed in, or still invited). */
export function lastActiveLabel(member: Pick<TeamMemberView, "lastActiveAt">, now: Date): string {
  return member.lastActiveAt ? relativeTime(new Date(member.lastActiveAt), now) : "\u2014";
}

export type RoleOption = { value: TeamRole; label: string };

/**
 * Roles offered in a row's select: all four for members, the invite roles for a pending invitation (Owner is granted
 * once they have joined; the API refuses it with 422). The current role is always included.
 */
export function roleOptionsFor(member: Pick<TeamMemberView, "status" | "role">): RoleOption[] {
  const roles: readonly TeamRole[] = member.status === "invited" ? INVITE_ROLES : TEAM_ROLES;
  const list = roles.includes(member.role) ? roles : [member.role, ...roles];
  return list.map((value) => ({ value, label: TEAM_ROLE_META[value].label }));
}

/** Accessible name of a row's role select (prototype "Role for {name or email}"). */
export function roleSelectLabel(member: Pick<TeamMemberView, "name" | "email">): string {
  return `Role for ${memberLabel(member)}`;
}

/** "Remove" for members, "Revoke invite" for invitations. */
export function removeLabel(member: Pick<TeamMemberView, "status">): string {
  return member.status === "invited" ? TEAM_COPY.revoke : TEAM_COPY.remove;
}

export type ConfirmCopy = { title: string; body: string; cta: string };

/** Prototype danger dialogs: remove a member or revoke an invitation. */
export function removeDialogCopy(member: Pick<TeamMemberView, "name" | "email" | "status">): ConfirmCopy {
  if (member.status === "invited") {
    return { title: `Revoke invite for ${member.email}?`, body: "The invitation link will stop working.", cta: "Revoke" };
  }
  return {
    title: `Remove ${memberLabel(member)}?`,
    body: "They\u2019ll lose access to licenses, keys and invoices immediately. Their past activity stays in the log.",
    cta: "Remove",
  };
}

/** "a Viewer", "an Owner". */
export function withArticle(label: string): string {
  return /^[aeiou]/i.test(label) ? `an ${label}` : `a ${label}`;
}

/** new (decisions.md: role changes ask for confirmation, no reason): "Make Rohan Sharma a Viewer?". */
export function roleChangeDialogCopy(member: Pick<TeamMemberView, "name" | "email" | "status">, role: TeamRole): ConfirmCopy {
  const meta = TEAM_ROLE_META[role];
  const when = member.status === "invited" ? "It applies when they accept the invitation." : "The change applies immediately.";
  return {
    title: `Make ${memberLabel(member)} ${withArticle(meta.label)}?`,
    body: `${meta.description} ${when}`,
    cta: TEAM_COPY.changeRole,
  };
}

// ---------- Invite form ----------

export type InviteRoleChoice = { value: InviteRole; label: string; description: string };

/** Role choices of the invite dialog with TEAM_ROLE_META descriptions; Technical contact is the default. */
export const INVITE_ROLE_CHOICES: readonly InviteRoleChoice[] = INVITE_ROLES.map((value) => ({
  value,
  label: TEAM_ROLE_META[value].label,
  description: TEAM_ROLE_META[value].description,
}));

export const DEFAULT_ROLE: InviteRole = DEFAULT_INVITE_ROLE;

export function isInviteRole(value: string): value is InviteRole {
  return (INVITE_ROLES as readonly string[]).includes(value);
}

/** Client check with the API's schema: "Enter a valid email address." or null. */
export function inviteEmailError(email: string): string | null {
  const parsed = inviteMemberSchema.safeParse({ email, role: DEFAULT_INVITE_ROLE });
  if (parsed.success) return null;
  const issue = parsed.error.issues.find((i) => i.path[0] === "email");
  return issue?.message ?? null;
}

/** The address as the API stores it (trimmed, lower-case), for the success toast. */
export function normalizedInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---------- Permission matrix ----------

/** Matrix columns: heading (upper-cased by CSS, prototype "TECHNICAL") and the full role name for labels. */
export const MATRIX_COLUMNS: readonly { role: TeamRole; heading: string; label: string }[] = TEAM_ROLES.map((role) => ({
  role,
  heading: role === "TECHNICAL" ? "Technical" : TEAM_ROLE_META[role].label,
  label: TEAM_ROLE_META[role].label,
}));

export type MatrixCell = { role: TeamRole; allowed: boolean; label: string };
export type MatrixRow = { label: string; cells: MatrixCell[] };

/** The prototype's "What each role can do" table from TEAM_MATRIX_ROWS: "Allowed|Not allowed for {role}". */
export function permissionMatrix(): MatrixRow[] {
  return TEAM_MATRIX_ROWS.map((row) => ({
    label: row.label,
    cells: TEAM_ROLES.map((role) => {
      const allowed = teamMatrixAllows(role, row);
      return { role, allowed, label: `${allowed ? "Allowed" : "Not allowed"} for ${TEAM_ROLE_META[role].label}` };
    }),
  }));
}
