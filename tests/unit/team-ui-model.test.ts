/**
 * Team & access and invitation page models (components/account/team/team-model.ts, components/auth/invite-model.ts):
 * prototype copy, status badges, role choices, confirmation copy, the permission matrix and the invite page states.
 */
import { describe, expect, it } from "vitest";
import {
  INVITE_ROLE_CHOICES,
  inviteEmailError,
  lastActiveLabel,
  MATRIX_COLUMNS,
  memberAvatar,
  memberLabel,
  membersSummary,
  memberStatusBadge,
  memberTitle,
  normalizedInviteEmail,
  permissionMatrix,
  removeDialogCopy,
  removeLabel,
  roleChangeDialogCopy,
  roleOptionsFor,
  roleSelectLabel,
  withArticle,
  DEFAULT_ROLE,
  TEAM_COPY,
} from "@/components/account/team/team-model";
import {
  INVITE_COPY,
  invitePath,
  isInviteGoneCode,
  isInviteProblemCode,
  problemAction,
  problemTitle,
  signInToAcceptHref,
  validateNewMember,
} from "@/components/auth/invite-model";
import { safeNext } from "@/lib/auth/redirect";
import { PASSWORD_ERROR } from "@/lib/validation/password";
import { TEAM_ERRORS } from "@/lib/validation/team";

const NOW = new Date("2026-10-07T10:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

type Member = Parameters<typeof memberStatusBadge>[0] & Parameters<typeof memberAvatar>[0];
const active = (patch: Partial<Member> = {}): Member => ({
  name: "Rohan Sharma",
  email: "rohan@sharmamedicals.example",
  status: "active",
  you: false,
  invitedAt: null,
  inviteExpired: false,
  ...patch,
});
const invited = (patch: Partial<Member> = {}): Member =>
  active({ name: "", email: "accounts@joshica.example", status: "invited", invitedAt: daysAgo(3), ...patch });

describe("team members", () => {
  it("summarises and names members as the prototype does", () => {
    expect(membersSummary({ active: 3, invited: 1 })).toBe("3 active · 1 invited");
    expect(memberTitle(active())).toBe("Rohan Sharma");
    expect(memberTitle(invited())).toBe("Invitation pending");
    expect(memberLabel(invited())).toBe("accounts@joshica.example");
    expect(roleSelectLabel(active())).toBe("Role for Rohan Sharma");
    expect(roleSelectLabel(invited())).toBe("Role for accounts@joshica.example");
  });

  it("uses initials for members and @ for invitations", () => {
    expect(memberAvatar(active())).toEqual({ text: "RS", tone: "lavender" });
    expect(memberAvatar(invited())).toEqual({ text: "@", tone: "slate" });
  });

  it("badges invitations, yourself and active members", () => {
    expect(memberStatusBadge(invited(), NOW)).toEqual({ label: "Invited 3d ago", tone: "peach" });
    expect(memberStatusBadge(invited({ inviteExpired: true }), NOW)).toEqual({ label: "Invite expired", tone: "peach" });
    expect(memberStatusBadge(active({ you: true }), NOW)).toEqual({ label: "You", tone: "lavender" });
    expect(memberStatusBadge(active(), NOW)).toEqual({ label: "Active", tone: "sage" });
  });

  it("shows last activity relative, or a dash", () => {
    expect(lastActiveLabel({ lastActiveAt: daysAgo(2) }, NOW)).toBe("2d ago");
    expect(lastActiveLabel({ lastActiveAt: null }, NOW)).toBe("\u2014");
  });

  it("offers every role to members but never Owner to a pending invitation", () => {
    expect(roleOptionsFor({ status: "active", role: "BILLING" }).map((o) => o.label)).toEqual([
      "Owner",
      "Billing admin",
      "Technical contact",
      "Viewer",
    ]);
    expect(roleOptionsFor({ status: "invited", role: "VIEWER" }).map((o) => o.value)).toEqual(["BILLING", "TECHNICAL", "VIEWER"]);
  });

  it("keeps the prototype's remove and revoke copy", () => {
    expect(removeLabel(active())).toBe("Remove");
    expect(removeLabel(invited())).toBe("Revoke invite");
    expect(removeDialogCopy(active())).toEqual({
      title: "Remove Rohan Sharma?",
      body: "They’ll lose access to licenses, keys and invoices immediately. Their past activity stays in the log.",
      cta: "Remove",
    });
    expect(removeDialogCopy(invited())).toEqual({
      title: "Revoke invite for accounts@joshica.example?",
      body: "The invitation link will stop working.",
      cta: "Revoke",
    });
  });

  it("confirms role changes with the role description", () => {
    expect(withArticle("Owner")).toBe("an Owner");
    expect(withArticle("Viewer")).toBe("a Viewer");
    expect(roleChangeDialogCopy(active(), "VIEWER")).toEqual({
      title: "Make Rohan Sharma a Viewer?",
      body: "Read-only access to licenses and invoices. The change applies immediately.",
      cta: "Change role",
    });
    expect(roleChangeDialogCopy(invited(), "BILLING").body).toBe(
      "Orders, invoices, renewals and billing details. It applies when they accept the invitation.",
    );
  });
});

describe("invite dialog", () => {
  it("offers the three invite roles with their descriptions, Technical contact first selected", () => {
    expect(INVITE_ROLE_CHOICES.map((c) => c.label)).toEqual(["Billing admin", "Technical contact", "Viewer"]);
    expect(INVITE_ROLE_CHOICES[1]?.description).toBe("Downloads, license keys, devices and tickets.");
    expect(DEFAULT_ROLE).toBe("TECHNICAL");
  });

  it("checks the email with the API's rule and message", () => {
    expect(inviteEmailError("")).toBe("Enter a valid email address.");
    expect(inviteEmailError("not-an-email")).toBe("Enter a valid email address.");
    expect(inviteEmailError(" Accounts@Joshica.Example ")).toBeNull();
    expect(normalizedInviteEmail(" Accounts@Joshica.Example ")).toBe("accounts@joshica.example");
    expect(TEAM_COPY.invitationSent("a@b.example")).toBe("Invitation sent to a@b.example");
  });
});

describe("permission matrix", () => {
  it("matches the prototype's table cell for cell", () => {
    const yes = (row: { cells: { allowed: boolean }[] }) => row.cells.map((c) => (c.allowed ? 1 : 0));
    expect(permissionMatrix().map((row) => [row.label, ...yes(row)])).toEqual([
      ["View licenses & invoices", 1, 1, 1, 1],
      ["Download software", 1, 0, 1, 0],
      ["Reveal license keys", 1, 0, 1, 0],
      ["Deactivate devices", 1, 0, 1, 0],
      ["Buy, renew and upgrade", 1, 1, 0, 0],
      ["Edit billing & GSTIN", 1, 1, 0, 0],
      ["Raise support tickets", 1, 1, 1, 0],
      ["Manage team & security", 1, 0, 0, 0],
    ]);
  });

  it("labels each cell for screen readers and heads columns like the prototype", () => {
    const row = permissionMatrix()[1];
    expect(row?.cells.map((c) => c.label)).toEqual([
      "Allowed for Owner",
      "Not allowed for Billing admin",
      "Allowed for Technical contact",
      "Not allowed for Viewer",
    ]);
    expect(MATRIX_COLUMNS.map((c) => c.heading.toUpperCase())).toEqual(["OWNER", "BILLING ADMIN", "TECHNICAL", "VIEWER"]);
  });
});

describe("invitation page", () => {
  it("knows the API's problem codes", () => {
    for (const code of ["invite_invalid", "invite_expired", "invite_revoked", "invite_used"]) {
      expect(isInviteProblemCode(code)).toBe(true);
      expect(isInviteGoneCode(code)).toBe(true);
    }
    expect(isInviteGoneCode("rate_limited")).toBe(false);
    expect(isInviteProblemCode("csrf_failed")).toBe(false);
    expect(problemTitle("invite_expired")).toBe("Invitation expired");
  });

  it("offers a way out of each problem", () => {
    expect(problemAction("invite_used", false, "/account")).toEqual({ label: "Sign in", href: "/sign-in" });
    expect(problemAction("invite_expired", false, "/account")).toEqual({ label: "Go to the homepage", href: "/" });
    expect(problemAction("invite_expired", true, "/admin")).toEqual({ label: "Go to your account", href: "/admin" });
  });

  it("sends existing members to sign in and back to the invitation", () => {
    const token = "cmabc123.secret_part-XYZ";
    expect(invitePath(token)).toBe("/invite?token=cmabc123.secret_part-XYZ");
    const href = signInToAcceptHref(token);
    const next = new URL(href, "http://x.invalid").searchParams.get("next");
    expect(next).toBe(invitePath(token));
    // The sign-in page only follows safe paths: the invitation must be one.
    expect(safeNext(next)).toBe(invitePath(token));
  });

  it("checks a new person's name and password with the API's messages", () => {
    expect(validateNewMember({ name: " ", password: "short" })).toEqual({ name: TEAM_ERRORS.name, password: PASSWORD_ERROR });
    expect(validateNewMember({ name: "see www.example.com", password: "longenough1" })).toEqual({ name: TEAM_ERRORS.nameLink });
    expect(validateNewMember({ name: "x".repeat(121), password: "longenough1" })).toEqual({ name: TEAM_ERRORS.nameTooLong });
    expect(validateNewMember({ name: "Asha Rao", password: "longenough1" })).toEqual({});
  });

  it("describes the invitation", () => {
    expect(INVITE_COPY.title("Sharma Medicals")).toBe("Join Sharma Medicals");
    expect(INVITE_COPY.subtitle("Priya Sharma", "Viewer")).toBe("Priya Sharma invited you to their team on Axiomatic as Viewer.");
    expect(INVITE_COPY.subtitle(null, "Viewer")).toBe("You’ve been invited to a team on Axiomatic as Viewer.");
  });
});
