/**
 * Admin records PART A (docs/admin-records-design.md A7, unit): the customer create / edit bodies (normalised like
 * registration and the portal), the field-name helpers used by the audit rows, the console form helpers and the
 * /reset copy by link mode.
 */
import { describe, expect, it } from "vitest";
import { resetFormCopy, AUTH_COPY } from "@/components/auth/copy";
import {
  changedCustomerFields,
  createdCustomerFields,
  CUSTOMER_FORM_ERRORS,
  customerCreatePayload,
  customerDraftErrors,
  customerEditDraft,
  customerEditPatch,
  draftChangesEmail,
  EMPTY_CUSTOMER_DRAFT,
  guestClaimNote,
  setPasswordExpiresText,
  type AdminCustomerDetail,
} from "@/lib/admin/customers/model";
import { customerCreateBody, customerDestructiveBody, customerPatchBody } from "@/lib/admin/customers/schemas";
import { SET_PASSWORD_PURPOSE, SET_PASSWORD_TTL_MS } from "@/lib/auth/flows/common";
import { PORTAL_ERRORS } from "@/lib/validation/portal";

const base = { name: "Kavita Joshi", email: "kavita@joshihardware.example", reason: "Phone order" };

function fieldErrors(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) out[issue.path.map(String).join(".") || "_form"] ??= issue.message;
  return out;
}

describe("customerCreateBody", () => {
  it("trims and lower-cases the email like registration and keeps the reason for requireReason()", () => {
    const parsed = customerCreateBody.parse({ ...base, email: "  Kavita@JoshiHardware.Example " });
    expect(parsed).toEqual({ name: "Kavita Joshi", email: "kavita@joshihardware.example", reason: "Phone order" });
    expect(customerCreateBody.parse({ name: "K", email: "k@a.example" }).reason).toBeUndefined();
  });

  it("refuses an invalid or missing email and a missing name", () => {
    expect(fieldErrors(customerCreateBody.safeParse({ ...base, email: "not-an-email" }))).toEqual({ email: CUSTOMER_FORM_ERRORS.email });
    expect(Object.keys(fieldErrors(customerCreateBody.safeParse({ reason: "x" }))).sort()).toEqual(["email", "name"]);
    expect(fieldErrors(customerCreateBody.safeParse({ ...base, name: "   " })).name).toBe(PORTAL_ERRORS.name);
  });

  it("normalises an Indian mobile number and turns an empty one into null", () => {
    expect(customerCreateBody.parse({ ...base, phone: "+91 98200 12345" }).phone).toBe("9820012345");
    expect(customerCreateBody.parse({ ...base, phone: "" }).phone).toBeNull();
    expect(fieldErrors(customerCreateBody.safeParse({ ...base, phone: "12345" })).phone).toBe(PORTAL_ERRORS.phone);
  });

  it("upper-cases a GSTIN and needs the state it is registered in", () => {
    const ok = customerCreateBody.parse({ ...base, gstin: " 08abcde1234f1z5 ", state: "Rajasthan" });
    expect(ok).toMatchObject({ gstin: "08ABCDE1234F1Z5", state: "Rajasthan" });
    expect(fieldErrors(customerCreateBody.safeParse({ ...base, gstin: "08ABCDE1234F1Z5" }))).toEqual({ state: PORTAL_ERRORS.gstinNeedsState });
    const other = fieldErrors(customerCreateBody.safeParse({ ...base, gstin: "08ABCDE1234F1Z5", state: "Kerala" }));
    expect(other.gstin).toContain("Rajasthan");
    expect(fieldErrors(customerCreateBody.safeParse({ ...base, gstin: "NOT-A-GSTIN" })).gstin).toBe(PORTAL_ERRORS.gstin);
  });

  it("treats an empty legal name and empty address fields as none", () => {
    const parsed = customerCreateBody.parse({ ...base, legalName: "  ", address: "", city: " Jaipur ", pin: "" });
    expect(parsed).toMatchObject({ legalName: null, address: null, city: "Jaipur", pin: null });
    expect(fieldErrors(customerCreateBody.safeParse({ ...base, pin: "3020" })).pin).toBe(PORTAL_ERRORS.pin);
  });

  it("is strict: unknown keys and a non-boolean emailVerified are refused", () => {
    const unknown = customerCreateBody.safeParse({ ...base, passwordHash: "x" });
    expect(unknown.success).toBe(false);
    expect(unknown.error?.issues[0]).toMatchObject({ code: "unrecognized_keys", keys: ["passwordHash"] });
    expect(customerCreateBody.safeParse({ ...base, emailVerified: "yes" }).success).toBe(false);
    expect(customerCreateBody.parse({ ...base, emailVerified: true }).emailVerified).toBe(true);
  });
});

describe("customerPatchBody", () => {
  it("needs a field to change besides the reason and emailVerified", () => {
    expect(fieldErrors(customerPatchBody.safeParse({}))).toEqual({ _form: CUSTOMER_FORM_ERRORS.nothingToUpdate });
    expect(fieldErrors(customerPatchBody.safeParse({ reason: "Typo fix", emailVerified: false }))).toEqual({ _form: CUSTOMER_FORM_ERRORS.nothingToUpdate });
    expect(customerPatchBody.parse({ phone: "", reason: "Typo fix" })).toEqual({ phone: null, reason: "Typo fix" });
  });

  it("refuses emailVerified without an email and normalises the new email", () => {
    expect(fieldErrors(customerPatchBody.safeParse({ name: "Kavita", emailVerified: true }))).toEqual({
      emailVerified: CUSTOMER_FORM_ERRORS.emailVerifiedWithoutChange,
    });
    expect(customerPatchBody.parse({ email: " New@Example.COM ", emailVerified: true })).toEqual({ email: "new@example.com", emailVerified: true });
  });

  it("does not let the business name be cleared and checks a GSTIN only on the merged details (in the service)", () => {
    expect(fieldErrors(customerPatchBody.safeParse({ legalName: "  " })).legalName).toBe(PORTAL_ERRORS.legalName);
    // A GSTIN alone is fine here: the stored state may match it.
    expect(customerPatchBody.parse({ gstin: "08abcde1234f1z5" }).gstin).toBe("08ABCDE1234F1Z5");
  });

  it("destructive bodies take a reason and an optional member id only", () => {
    expect(customerDestructiveBody.parse({ reason: "Checked on a call", userId: "cm1abc" })).toEqual({ reason: "Checked on a call", userId: "cm1abc" });
    expect(customerDestructiveBody.parse({})).toEqual({});
    expect(customerDestructiveBody.safeParse({ reason: "x", email: "a@b.example" }).success).toBe(false);
    expect(customerDestructiveBody.safeParse({ userId: "../etc" }).success).toBe(false);
  });
});

describe("audit field names", () => {
  const business = { legalName: "Joshi Hardware", gstin: null, address: null, city: "Jaipur", state: "Rajasthan", pin: null };
  const person = { name: "Kavita Joshi", phone: "9820012345", email: "kavita@joshihardware.example" };

  it("lists only the names of the fields that change, person first", () => {
    const next = { ...business, gstin: "08ABCDE1234F1Z5", city: "Ajmer" };
    expect(changedCustomerFields(person, business, { name: "Kavita J", phone: "9820012345", email: "k@new.example" }, next)).toEqual([
      "name",
      "email",
      "gstin",
      "city",
    ]);
    const text = JSON.stringify(changedCustomerFields(person, business, { email: "k@new.example" }, next));
    expect(text).not.toContain("k@new.example");
    expect(text).not.toContain("08ABCDE1234F1Z5");
  });

  it("is empty for a no-op and ignores person fields without an owner", () => {
    expect(changedCustomerFields(person, business, { ...person }, { ...business })).toEqual([]);
    expect(changedCustomerFields(null, business, { name: "Someone" }, { ...business, pin: "302001" })).toEqual(["pin"]);
  });

  it("names the fields a customer was created with", () => {
    expect(createdCustomerFields({ phone: "9820012345", legalName: null, gstin: "08ABCDE1234F1Z5", city: "Jaipur", state: "Rajasthan" })).toEqual([
      "name",
      "email",
      "phone",
      "gstin",
      "city",
      "state",
    ]);
    expect(createdCustomerFields({})).toEqual(["name", "email"]);
  });

  it("describes link lifetimes for the email", () => {
    expect(SET_PASSWORD_TTL_MS).toBe(7 * 86_400_000);
    expect(SET_PASSWORD_PURPOSE).toBe("set_password");
    expect(setPasswordExpiresText(SET_PASSWORD_TTL_MS)).toBe("7 days");
    expect(setPasswordExpiresText(30 * 60_000)).toBe("30 minutes");
    expect(setPasswordExpiresText(86_400_000)).toBe("1 day");
  });
});

describe("console form helpers", () => {
  const detail = {
    legalName: "Joshi Hardware",
    gstin: null,
    address: null,
    city: "Jaipur",
    state: "Rajasthan",
    pin: null,
    owner: {
      userId: "u1",
      name: "Kavita Joshi",
      email: "kavita@joshihardware.example",
      phone: "9820012345",
      role: "OWNER",
      status: "ACTIVE",
      verified: false,
      hasPassword: false,
      createdByStaff: true,
      canSetPassword: true,
    },
  } satisfies Pick<AdminCustomerDetail, "legalName" | "gstin" | "address" | "city" | "state" | "pin" | "owner">;

  it("sends only changed fields, empty optional ones as null, and emailVerified only with a new email", () => {
    const draft = customerEditDraft(detail);
    expect(customerEditPatch(detail, draft)).toEqual({});
    expect(customerEditPatch(detail, { ...draft, phone: "", city: " Ajmer ", emailVerified: true })).toEqual({ phone: null, city: "Ajmer" });
    const emailChange = { ...draft, email: " Kavita@New.Example ", emailVerified: true };
    expect(draftChangesEmail(detail, emailChange)).toBe(true);
    expect(customerEditPatch(detail, emailChange)).toEqual({ email: "Kavita@New.Example", emailVerified: true });
    expect(draftChangesEmail(detail, { email: "KAVITA@joshihardware.example " })).toBe(false);
    // Without an owner only the business details are sent.
    expect(customerEditPatch({ ...detail, owner: null }, { ...draft, name: "X", pin: "302001" })).toEqual({ pin: "302001" });
  });

  it("checks the basics before sending and builds the create body", () => {
    expect(customerDraftErrors(EMPTY_CUSTOMER_DRAFT, "create")).toEqual({
      name: CUSTOMER_FORM_ERRORS.name,
      email: CUSTOMER_FORM_ERRORS.email,
      reason: "Add a short reason for the audit log.",
    });
    expect(customerDraftErrors({ ...EMPTY_CUSTOMER_DRAFT, reason: "Phone order" }, "edit")).toEqual({});
    expect(
      customerCreatePayload({ ...EMPTY_CUSTOMER_DRAFT, name: " Kavita ", email: "k@a.example", city: " Jaipur ", emailVerified: true, reason: " Walk-in " }),
    ).toEqual({ name: "Kavita", email: "k@a.example", city: "Jaipur", emailVerified: true, reason: "Walk-in" });
  });
});

describe("/reset copy by link mode", () => {
  it("reads 'Set your password' for an account without one and keeps the reset copy otherwise", () => {
    const set = resetFormCopy("set");
    expect(set.title).toBe("Set your password");
    expect(set.subtitle("k@a.example")).toBe("For k@a.example. Choose a password to sign in to Axiomatic.");
    expect(set.cta).toBe("Set password");
    expect(set.password).toBe("Password");
    const reset = resetFormCopy("reset");
    expect(reset.title).toBe(AUTH_COPY.reset.title);
    expect(reset.cta).toBe("Update password");
    // Links of either kind: no promise of a 30-minute lifetime any more.
    expect(AUTH_COPY.reset.invalidSubtitle).toBe("Links work once and expire after a while. Ask for a new one below.");
  });
});

describe("guest-claim audit note (review fix)", () => {
  it("lists the orders a staff-verified address moved into the account, and nothing when none moved", () => {
    expect(guestClaimNote([])).toBe("");
    expect(guestClaimNote(["AX-10291"])).toBe(" · 1 guest order moved to this account: AX-10291");
    expect(guestClaimNote(["AX-10291", "AX-10307"])).toBe(" · 2 guest orders moved to this account: AX-10291, AX-10307");
    const many = Array.from({ length: 23 }, (_, i) => `AX-${10_300 + i}`);
    const note = guestClaimNote(many);
    expect(note).toMatch(/^ · 23 guest orders moved to this account: AX-10300, .*AX-10319 and 3 more$/);
    expect(note).not.toContain("AX-10320");
  });
});
