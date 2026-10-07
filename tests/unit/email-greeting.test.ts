import { describe, expect, it } from "vitest";
import { greetingName } from "@/lib/email/greeting";
import { greetingName as leadGreetingName } from "@/lib/leads";
import { registerSchema } from "@/lib/validation/auth";
import { billingSchema } from "@/lib/validation/billing";
import { isLinkLikeName, NAME_LINK_ERROR } from "@/lib/validation/names";

describe("greetingName (every customer email)", () => {
  it("keeps real names, including initials, honorifics and non-Latin scripts", () => {
    for (const name of ["Priya Sharma", "R.Sharma", "Dr. K. Iyer", "Mohammed Abdul Rahman", "प्रिया शर्मा", "O'Brien-Nair"]) {
      expect(greetingName(name)).toBe(name);
    }
    expect(greetingName("  Asha\n Rao\t")).toBe("Asha Rao");
  });

  it("falls back to 'there' for links, addresses, markup, phone numbers, messages and blanks", () => {
    for (const spam of [
      "Your account is on hold. Verify at https://axiomatic-billing.example/secure",
      "visit evil.com now",
      "www.win",
      "a@b.co",
      "<b>x</b>",
      "Call 98200 00000",
      "Refund pending call 9820000000",
      "Your account is on hold please call support today",
      "x".repeat(61),
      "   ",
      "",
      null,
      undefined,
    ]) {
      expect(greetingName(spam)).toBe("there");
    }
  });

  it("is the helper the lead acknowledgement uses", () => {
    expect(leadGreetingName).toBe(greetingName);
  });
});

describe("link-like person names are refused at the form", () => {
  const register = (name: string) => registerSchema.safeParse({ name, email: "priya@example.com", password: "Correct1horse" });
  const billing = (name: string) =>
    billingSchema.safeParse({
      name,
      email: "priya@example.com",
      phone: "9820000000",
      address: "12 MG Road",
      city: "Pune",
      state: "Maharashtra",
      pin: "411001",
    });
  const messages = (r: { success: boolean; error?: { issues: { message: string }[] } }) => r.error?.issues.map((i) => i.message) ?? [];

  it("rejects names with an address or a URL, with one message", () => {
    for (const name of ["priya@example.com", "https://x.example", "Visit www.example.com"]) {
      expect(isLinkLikeName(name)).toBe(true);
      expect(messages(register(name))).toEqual([NAME_LINK_ERROR]);
      expect(messages(billing(name))).toEqual([NAME_LINK_ERROR]);
    }
    expect(NAME_LINK_ERROR).toBe("Enter your name without links or email addresses.");
  });

  it("accepts ordinary names", () => {
    for (const name of ["Priya Sharma", "R.Sharma", "Dr. K. Iyer"]) {
      expect(register(name).success).toBe(true);
      expect(billing(name).success).toBe(true);
    }
  });
});
