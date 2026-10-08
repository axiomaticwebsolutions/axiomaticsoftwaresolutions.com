import { describe, expect, it } from "vitest";
import { STAFF_INVITE_COPY, staffInviteProblemAction, validateStaffInvite, isStaffInviteGoneCode } from "@/components/admin/staff/staff-invite-model";
import { parseListQuery } from "@/lib/admin/list-query";
import {
  acceptStaffInviteSchema,
  inviteStaffSchema,
  PERMISSION_LABELS,
  PERMISSION_ROWS,
  permissionCountLabel,
  STAFF_COPY,
  STAFF_CSV_COLUMNS,
  STAFF_LIST_SPEC,
  STAFF_LIST_STATE,
  staffDisplayName,
  staffExportDetail,
  staffStatusLabel,
  staffStatusKey,
  twoStepLabel,
  type StaffRow,
} from "@/lib/admin/staff/model";
import { PERMISSIONS } from "@/lib/rbac";
import { listStateToParams, parseListState } from "@/lib/url-state";

const row = (over: Partial<StaffRow> = {}): StaffRow => ({
  id: "u1",
  name: "Vikram Rao",
  email: "vikram@axiomatic.example",
  role: "ADMIN",
  status: "active",
  twoStepEnabled: true,
  lastActiveAt: "2026-10-06T14:00:00.000Z",
  createdAt: "2025-09-02T04:30:00.000Z",
  invite: null,
  ...over,
});

describe("staff model", () => {
  it("shows two-step as each person's own setting: no role forces it (decisions.md 2026-10-08)", () => {
    for (const role of ["OWNER", "ADMIN", "SUPPORT", "FINANCE"] as const) {
      expect(twoStepLabel(row({ role, twoStepEnabled: false })), role).toBe("Off");
      expect(twoStepLabel(row({ role, twoStepEnabled: true })), role).toBe("On");
    }
    expect(STAFF_CSV_COLUMNS.find((c) => c.header === "Two-step sign-in")?.value(row({ role: "OWNER", twoStepEnabled: false }))).toBe("Off");
    // No copy promises a forced code any more (the role-change dialog and the invitation page used to).
    expect(JSON.stringify(STAFF_COPY)).not.toMatch(/always sign in with an emailed code/i);
    expect(JSON.stringify(STAFF_INVITE_COPY)).not.toMatch(/code we email/i);
  });

  it("labels statuses, names and permission counts from lib/rbac", () => {
    expect(staffStatusLabel(row())).toBe("Active");
    expect(staffStatusLabel(row({ status: "invited", invite: { sentAt: "", expiresAt: "", expired: false } }))).toBe("Invited");
    expect(staffStatusLabel(row({ status: "invited", invite: { sentAt: "", expiresAt: "", expired: true } }))).toBe("Invite expired");
    expect(staffStatusLabel(row({ status: "invited", invite: null }))).toBe("Invite expired");
    expect(staffStatusLabel(row({ status: "deactivated" }))).toBe("Deactivated");
    expect(staffStatusKey("DEACTIVATED")).toBe("deactivated");
    expect(staffStatusKey(null)).toBe("active");
    expect(staffDisplayName(row({ name: "  " }))).toBe("vikram@axiomatic.example");
    expect(["OWNER", "ADMIN", "SUPPORT", "FINANCE"].map((r) => permissionCountLabel(r as never))).toEqual([
      "29 permissions",
      "21 permissions",
      "11 permissions",
      "12 permissions",
    ]);
    expect(Object.keys(PERMISSION_LABELS).sort()).toEqual([...PERMISSIONS].sort());
    expect(PERMISSION_ROWS.map((r) => r.key)).toEqual(PERMISSIONS);
  });

  it("validates invitations and acceptance strictly", () => {
    expect(inviteStaffSchema.parse({ email: "  New.Person@Axiomatic.Example ", role: "SUPPORT" })).toEqual({ email: "new.person@axiomatic.example", role: "SUPPORT" });
    expect(inviteStaffSchema.safeParse({ email: "x@y.z", role: "ROOT" }).success).toBe(false);
    expect(inviteStaffSchema.safeParse({ email: "x@example.com", role: "SUPPORT", extra: 1 }).success).toBe(false);
    expect(acceptStaffInviteSchema.parse({ token: "a.b", name: "  Meera  ", password: "Console2joined" }).name).toBe("Meera");
    expect(acceptStaffInviteSchema.safeParse({ token: "a.b", name: "Meera", password: "short" }).success).toBe(false);
    expect(acceptStaffInviteSchema.safeParse({ token: "a.b", name: "meera@example.com", password: "Console2joined" }).success).toBe(false);
  });

  it("reads the list query like the API and the page URL", () => {
    const q = parseListQuery("q=rao&filter[role]=support&filter[status]=nope&sort=-lastActive&page=2&pageSize=500", STAFF_LIST_SPEC);
    expect(q).toMatchObject({ q: "rao", filters: { role: "support" }, sort: { id: "lastActive", desc: true }, page: 2, pageSize: 100 });
    expect(parseListQuery("", STAFF_LIST_SPEC).sort).toEqual({ id: "role", desc: false });
    const state = parseListState(new URLSearchParams("filter[role]=finance&sort=name"), STAFF_LIST_STATE);
    expect(listStateToParams(state, STAFF_LIST_STATE).toString()).toBe("filter%5Brole%5D=finance&sort=name");
    expect(staffExportDetail({ q: "rao", filters: { role: "support", status: "active" } })).toBe("role: Support \u00B7 status: active \u00B7 search: rao");
    expect(staffExportDetail({ q: "", filters: {} })).toBeNull();
  });

  it("writes CSV rows without secrets", () => {
    const values = STAFF_CSV_COLUMNS.map((c) => c.value(row()));
    expect(values).toEqual(["Vikram Rao", "vikram@axiomatic.example", "Administrator", "Active", "On", "6 Oct 2026, 7:30 pm", "2 Sep 2025, 10:00 am"]);
  });
});

describe("staff invitation page model", () => {
  it("checks name and password before sending", () => {
    expect(validateStaffInvite({ name: " ", password: "x" })).toEqual({ name: "Enter your name.", password: "Use at least 8 characters with letters and a number." });
    expect(validateStaffInvite({ name: "Meera Iyer", password: "Console2joined" })).toEqual({});
    expect(validateStaffInvite({ name: "www.spam.example", password: "Console2joined" }).name).toMatch(/without links/);
  });

  it("offers a way out of each problem state", () => {
    expect(staffInviteProblemAction("invite_used", null)).toEqual({ label: STAFF_INVITE_COPY.signIn, href: "/sign-in" });
    expect(staffInviteProblemAction("invite_expired", null)).toEqual({ label: STAFF_INVITE_COPY.home, href: "/" });
    expect(staffInviteProblemAction("invite_expired", "/admin")).toEqual({ label: STAFF_INVITE_COPY.goToAccount, href: "/admin" });
    expect(["invite_used", "invite_changed", "signed_in"].map(isStaffInviteGoneCode)).toEqual([true, true, false]);
    expect(STAFF_INVITE_COPY.subtitle(null, "Support")).toBe("You\u2019ve been invited to the Axiomatic admin console as Support.");
  });
});

describe("staff_invite email", () => {
  const FOOTER = { legalName: "Axiomatic", address: "1 Road", city: "Pune", state: "Maharashtra", pin: "411001", supportEmail: "s@a.example" };

  it("is a direct (never stored) template seeded with the same copy, rendering the button and the expiry", async () => {
    const { EMAIL_TEMPLATE_DEFAULTS, isAuthEmailTemplateId, isDirectEmailTemplateId } = await import("@/lib/email/defaults");
    const { renderEmail } = await import("@/lib/email/render");
    const { NOTIFICATION_TEMPLATES } = await import("@/prisma/seed-data/content");
    const t = EMAIL_TEMPLATE_DEFAULTS.staff_invite;
    expect(isAuthEmailTemplateId("staff_invite")).toBe(false);
    // It carries a console-access link: sent directly after the commit, never written to the outbox.
    expect(isDirectEmailTemplateId("staff_invite")).toBe(true);
    expect([...t.required]).toEqual(["inviter_name", "role_label", "invite_url", "expires"]);
    expect(NOTIFICATION_TEMPLATES.find((s) => s.id === "staff_invite")).toMatchObject({ name: t.name, subject: t.subject, body: t.body, active: true });
    const out = renderEmail({ subject: t.subject, body: t.body, blocks: t.blocks, vars: t.sampleVars, footer: FOOTER, appUrl: "https://a.example", unknownVars: "blank" });
    expect(out.subject).toBe("Anita Desai invited you to the Axiomatic admin console");
    expect(out.html).toContain('href="https://axiomaticsoftwaresolutions.com/staff-invite?token=sample"');
    expect(out.text).toContain("admin console as Support");
    expect(out.text).toContain("The invitation expires on 14 Oct 2026.");
    expect(out.unknownVars).toEqual([]);
  });
});
