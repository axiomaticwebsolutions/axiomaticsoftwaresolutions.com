/**
 * Launch waitlist ("Notify me when it launches" on a COMING_SOON product page; decisions.md 2026-10-09): the form body,
 * the request schema, lead ids and the internal lead_new email it sends (no acknowledgement to the visitor).
 * The route: tests/unit/lead-validation.test.ts; storage and de-duplication: tests/db/leads.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { Lead } from "@/generated/prisma/client";
import { EMPTY_WAITLIST_VALUES, WAITLIST_FIELD_ORDER, waitlistFieldId, waitlistRequestBody } from "@/components/store/product/waitlist-model";
import { LEAD_KIND_ENUM, LEAD_KIND_LABELS, LEAD_KIND_VALUES } from "@/lib/admin/leads/model";
import { EMAIL_TEMPLATE_DEFAULTS } from "@/lib/email/defaults";
import { renderEmail } from "@/lib/email/render";
import { acknowledgesLead, decoyLeadId, formatLeadId, leadEmailVars, LEAD_ID_PREFIX, WAITLIST_TOPIC } from "@/lib/leads";
import { createLeadRequestSchema, LEAD_ERRORS, leadFieldErrors } from "@/lib/validation/lead";

const schema = createLeadRequestSchema({ demoProductIds: ["medical-billing"], waitlistProductIds: ["payroll", "clinic-opd"] });
const values = { ...EMPTY_WAITLIST_VALUES, name: "  Asha  Rao ", email: " Asha@Example.com " };

describe("waitlist form body and schema", () => {
  it("sends kind waitlist with the product and its page as the source", () => {
    expect(waitlistRequestBody("payroll", values)).toEqual({
      kind: "waitlist",
      name: "  Asha  Rao ",
      email: " Asha@Example.com ",
      phone: "",
      businessName: "",
      product: "payroll",
      website: "",
      source: "product:payroll",
    });
    expect(WAITLIST_FIELD_ORDER.map(waitlistFieldId)).toEqual(["waitlist-name", "waitlist-email", "waitlist-phone", "waitlist-businessName"]);
  });

  it("needs a name and an email; phone and business name are optional", () => {
    const parsed = schema.parse(waitlistRequestBody("payroll", values));
    expect(parsed).toEqual({
      honeypot: false,
      lead: {
        kind: "WAITLIST",
        name: "Asha Rao",
        businessName: null,
        email: "asha@example.com",
        phone: null,
        productId: "payroll",
        countersBand: null,
        preferredDate: null,
        preferredSlot: null,
        topic: null,
        message: null,
        marketingOptIn: false,
        source: "product:payroll",
      },
    });
    const full = schema.parse(waitlistRequestBody("clinic-opd", { ...values, phone: "98200 00000", businessName: " Rao Clinic " }));
    expect(full.lead).toMatchObject({ phone: "9820000000", businessName: "Rao Clinic", productId: "clinic-opd" });

    const empty = schema.safeParse(waitlistRequestBody("payroll", EMPTY_WAITLIST_VALUES));
    expect(empty.success).toBe(false);
    if (!empty.success) expect(leadFieldErrors(empty.error)).toEqual({ name: LEAD_ERRORS.name, email: LEAD_ERRORS.email });
    const badPhone = schema.safeParse(waitlistRequestBody("payroll", { ...values, phone: "12345" }));
    expect(badPhone.success).toBe(false);
  });

  it("accepts only the coming-soon products it was given, and no unknown keys", () => {
    for (const product of ["medical-billing", "nope", "", "x".repeat(65)]) {
      const r = schema.safeParse(waitlistRequestBody(product, values));
      expect(r.success, product).toBe(false);
      if (!r.success) expect(leadFieldErrors(r.error)).toEqual({ product: LEAD_ERRORS.waitlistProduct });
    }
    expect(createLeadRequestSchema({ demoProductIds: [] }).safeParse(waitlistRequestBody("payroll", values)).success).toBe(false);
    expect(schema.safeParse({ ...waitlistRequestBody("payroll", values), topic: "sales" }).success).toBe(false);
    // The form offers no marketing consent (its stated purpose is the launch email only): a crafted opt-in is refused.
    for (const marketingOptIn of [true, false]) {
      const crafted = schema.safeParse({ ...waitlistRequestBody("payroll", values), marketingOptIn });
      expect(crafted.success, String(marketingOptIn)).toBe(false);
      if (!crafted.success) expect(crafted.error.issues[0]?.code).toBe("unrecognized_keys");
    }
    expect(schema.parse({ ...waitlistRequestBody("payroll", values), website: "x" }).honeypot).toBe(true);
  });
});

describe("waitlist leads", () => {
  it("numbers them WAIT-1001, WAIT-1002, ... from the shared lead counter", () => {
    expect(LEAD_ID_PREFIX.WAITLIST).toBe("WAIT-");
    expect(formatLeadId("WAITLIST", 1001)).toBe("WAIT-1001");
    expect(decoyLeadId("WAITLIST", () => 0.5)).toMatch(/^WAIT-\d{4,5}$/);
  });

  it("sends sales the lead_new notice, which reads sensibly for a waitlist, and no acknowledgement to the visitor", () => {
    expect(acknowledgesLead("WAITLIST")).toBe(false);
    expect(acknowledgesLead("DEMO")).toBe(true);
    expect(acknowledgesLead("CONTACT")).toBe(true);
    const lead = {
      id: "WAIT-1004",
      kind: "WAITLIST",
      status: "NEW",
      name: "Asha Rao",
      businessName: "Rao Traders",
      email: "asha@example.com",
      phone: "9820000000",
      productId: "payroll",
      countersBand: null,
      preferredDate: null,
      preferredSlot: null,
      topic: null,
      message: null,
      marketingOptIn: false,
      source: "product:payroll",
      ipPrefix: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Lead;
    const { notice } = leadEmailVars(lead, { productName: "Payroll & Attendance Software" });
    expect(notice).toMatchObject({
      reference: "WAIT-1004",
      kind_label: "launch waitlist sign-up",
      name: "Asha Rao",
      email: "asha@example.com",
      phone: "+91 98200 00000",
      product: "Payroll & Attendance Software",
      business: "Rao Traders",
      topic: WAITLIST_TOPIC,
      preferred: "",
      counters: "",
      source: "product:payroll",
    });
    expect(notice.message).toBe(
      "Asked to be emailed when Payroll & Attendance Software launches. No reply is needed now: the website promised only a launch email.",
    );
    const t = EMAIL_TEMPLATE_DEFAULTS.lead_new;
    for (const name of t.required) expect(notice[name], name).toBeTruthy();
    const footer = { legalName: "Axiomatic", address: "1 Road", city: "Pune", state: "Maharashtra", pin: "411001", supportEmail: "s@a.example" };
    const out = renderEmail({ subject: t.subject, body: t.body, blocks: t.blocks, vars: notice, footer, appUrl: "https://a.example", unknownVars: "blank" });
    expect(out.subject).toBe("New launch waitlist sign-up: WAIT-1004 from Asha Rao");
    expect(out.text).toContain("Product: Payroll & Attendance Software");
    expect(out.text).toContain("Topic: Launch waitlist");
    expect(out.text).toContain("No reply is needed now");
    expect(out.unknownVars).toEqual([]);
  });

  it("shows them in Admin > Leads as Waitlist, with a filter", () => {
    expect(LEAD_KIND_VALUES).toContain("waitlist");
    expect(LEAD_KIND_ENUM.waitlist).toBe("WAITLIST");
    expect(LEAD_KIND_LABELS.WAITLIST).toBe("Waitlist");
  });
});
