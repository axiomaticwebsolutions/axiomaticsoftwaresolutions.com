/**
 * The team_invite email (lib/email/defaults.ts) and the text rules that keep owner-typed names from turning it into a
 * phishing vehicle (lib/portal/invites.ts), plus the activity CSV columns (lib/portal/activity.ts).
 */
import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATE_DEFAULTS, isAuthEmailTemplateId, isDirectEmailTemplateId } from "@/lib/email/defaults";
import { renderEmail } from "@/lib/email/render";
import { toCsv } from "@/lib/csv";
import { ACTIVITY_CSV_COLUMNS } from "@/lib/portal/activity";
import { emailSafeAccountName, emailSafeInviterName } from "@/lib/portal/invites";
import { NOTIFICATION_TEMPLATES } from "@/prisma/seed-data/content";

const FOOTER = { legalName: "Axiomatic", address: "1 Road", city: "Pune", state: "Maharashtra", pin: "411001", supportEmail: "s@a.example" };

describe("team_invite template", () => {
  const t = EMAIL_TEMPLATE_DEFAULTS.team_invite;

  it("is a direct (never stored) template with the agreed variables, seeded with the same copy", () => {
    expect(isAuthEmailTemplateId("team_invite")).toBe(false);
    expect(isDirectEmailTemplateId("team_invite")).toBe(true);
    expect([...t.vars]).toEqual(["inviter_name", "account_name", "role_label", "invite_url", "expires"]);
    expect([...t.required]).toEqual([...t.vars]);
    const seed = NOTIFICATION_TEMPLATES.find((s) => s.id === "team_invite");
    expect(seed).toMatchObject({ name: t.name, subject: t.subject, body: t.body, active: true });
  });

  it("renders the button with the link and the expiry note", () => {
    const out = renderEmail({ subject: t.subject, body: t.body, blocks: t.blocks, vars: t.sampleVars, footer: FOOTER, appUrl: "https://a.example", unknownVars: "blank" });
    expect(out.subject).toBe("Priya Sharma invited you to Sharma Medicals on Axiomatic");
    expect(out.html).toContain('href="https://axiomaticsoftwaresolutions.com/invite?token=sample"');
    expect(out.text).toContain("as Technical contact");
    expect(out.text).toContain("The invitation expires on 14 Oct 2026.");
    expect(out.unknownVars).toEqual([]);
  });
});

describe("email-safe names", () => {
  it("keeps ordinary business names, Indian style included", () => {
    expect(emailSafeAccountName("Sharma Medicals")).toBe("Sharma Medicals");
    expect(emailSafeAccountName("M/s Joshi & Sons Hardware Pvt. Ltd.")).toBe("M/s Joshi & Sons Hardware Pvt. Ltd.");
    expect(emailSafeAccountName("Shree Ganesh Medical and General Stores Private Limited")).toBe(
      "Shree Ganesh Medical and General Stores Private Limited",
    );
  });

  it("replaces names that carry links, addresses or phone numbers", () => {
    for (const name of ["Verify at https://evil.example", "www.evil.example", "pay-now.com", "Call 98200 00000 today", "a@b.example", "<b>x</b>", ""]) {
      expect(emailSafeAccountName(name), name).toBe("a business account");
    }
    expect(emailSafeInviterName("Priya Sharma")).toBe("Priya Sharma");
    expect(emailSafeInviterName("Click www.evil.example")).toBe("A teammate");
    expect(emailSafeInviterName("")).toBe("A teammate");
  });
});

describe("activity CSV", () => {
  it("writes When (ISO), Who, Action, Item, Type with quoted cells, a BOM and defused formulas", () => {
    const row = { createdAt: new Date("2026-10-07T10:00:00.000Z"), actorName: "Priya, Sharma", action: "Invited team member", target: '=HYPERLINK("x")', kind: "team" };
    const csv = toCsv([row], ACTIVITY_CSV_COLUMNS);
    expect(csv).toBe(
      '\uFEFF"When","Who","Action","Item","Type"\r\n' +
        `"2026-10-07T10:00:00.000Z","Priya, Sharma","Invited team member","'=HYPERLINK(""x"")","team"\r\n`,
    );
  });
});
