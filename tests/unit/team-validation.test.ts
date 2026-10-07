/**
 * Team, invitation and activity-log request validation (lib/validation/team.ts).
 */
import { describe, expect, it } from "vitest";
import {
  acceptInviteSchema,
  ACTIVITY_KIND_LABELS,
  ACTIVITY_KINDS,
  changeRoleSchema,
  inviteMemberSchema,
  INVITE_ROLES,
  parseActivityQuery,
  TEAM_ERRORS,
} from "@/lib/validation/team";

type Issues = { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } };
function fieldErrors(result: Issues) {
  const out: Record<string, string[]> = {};
  for (const issue of result.error?.issues ?? []) (out[issue.path.map(String).join(".")] ??= []).push(issue.message);
  return out;
}

describe("inviteMemberSchema", () => {
  it("lower-cases the email and defaults to Technical contact", () => {
    expect(inviteMemberSchema.parse({ email: "  Accounts@Joshica.Example " })).toEqual({ email: "accounts@joshica.example", role: "TECHNICAL" });
    expect(inviteMemberSchema.parse({ email: "a@b.example", role: "VIEWER" }).role).toBe("VIEWER");
  });

  it("never invites an Owner and uses the prototype email message", () => {
    expect(INVITE_ROLES).toEqual(["BILLING", "TECHNICAL", "VIEWER"]);
    expect(fieldErrors(inviteMemberSchema.safeParse({ email: "a@b.example", role: "OWNER" }))).toEqual({ role: [TEAM_ERRORS.role] });
    expect(fieldErrors(inviteMemberSchema.safeParse({ email: "not an email" }))).toEqual({ email: ["Enter a valid email address."] });
    expect(inviteMemberSchema.safeParse({ email: "a@b.example", accountId: "other" }).success).toBe(false);
  });
});

describe("changeRoleSchema", () => {
  it("accepts every team role, Owner included", () => {
    for (const role of ["OWNER", "BILLING", "TECHNICAL", "VIEWER"]) expect(changeRoleSchema.parse({ role }).role).toBe(role);
    expect(changeRoleSchema.safeParse({ role: "ADMIN" }).success).toBe(false);
    expect(changeRoleSchema.safeParse({}).success).toBe(false);
  });
});

describe("acceptInviteSchema", () => {
  it("needs the token; name and password are optional but checked when present", () => {
    expect(acceptInviteSchema.parse({ token: "abc.def" })).toEqual({ token: "abc.def" });
    expect(acceptInviteSchema.parse({ token: "t", name: "  Asha Rao ", password: "Correct1horse" })).toEqual({
      token: "t",
      name: "Asha Rao",
      password: "Correct1horse",
    });
    expect(fieldErrors(acceptInviteSchema.safeParse({ token: "t", password: "short" }))).toEqual({
      password: ["Use at least 8 characters with letters and a number."],
    });
    expect(fieldErrors(acceptInviteSchema.safeParse({ token: "t", name: "Visit www.evil.example" }))).toEqual({ name: [TEAM_ERRORS.nameLink] });
    expect(fieldErrors(acceptInviteSchema.safeParse({ token: "t", name: "  " }))).toEqual({ name: [TEAM_ERRORS.name] });
    expect(acceptInviteSchema.safeParse({ token: "" }).success).toBe(false);
    expect(acceptInviteSchema.safeParse({ token: "x".repeat(257) }).success).toBe(false);
    expect(acceptInviteSchema.safeParse({ token: "t", role: "OWNER" }).success).toBe(false);
  });
});

describe("parseActivityQuery", () => {
  it("defaults to all kinds, no search, page 1", () => {
    expect(parseActivityQuery(new URLSearchParams())).toEqual({ kind: "all", q: "", page: 1 });
  });

  it("accepts the six kinds with the prototype filter labels", () => {
    expect([...ACTIVITY_KINDS]).toEqual(["license", "security", "billing", "team", "ticket", "download"]);
    expect(Object.values(ACTIVITY_KIND_LABELS)).toEqual(["All activity", "Licenses & devices", "Security", "Billing", "Team", "Support", "Downloads"]);
    expect(parseActivityQuery(new URLSearchParams("kind=team&q=%20Rohan%20&page=2"))).toEqual({ kind: "team", q: "Rohan", page: 2 });
  });

  it("throws (422) for unknown kinds and bad pages", () => {
    expect(() => parseActivityQuery(new URLSearchParams("kind=admin"))).toThrow();
    expect(() => parseActivityQuery(new URLSearchParams("page=-1"))).toThrow();
    expect(() => parseActivityQuery(new URLSearchParams("page=abc"))).toThrow();
  });
});
