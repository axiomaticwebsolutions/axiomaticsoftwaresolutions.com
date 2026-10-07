/**
 * Checkout alerts: "Create an account" with an email that already has one (409 email_taken) shows ONE alert (the
 * prototype replaces the form error with the server message), and "Sign in instead." is a link, as on /register.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AUTH_COPY } from "@/components/auth/copy";
import { CHECKOUT_PATH, emailTakenFormError, showFieldSummary } from "@/components/checkout/checkout-form";
import { AUTH_MESSAGES } from "@/lib/auth/flows/common";

describe("email_taken at checkout", () => {
  it("reads like the server message, with the sign-in part as a link back to checkout", () => {
    const error = emailTakenFormError();
    expect(`${error.message} ${error.link?.label}`).toBe(AUTH_MESSAGES.emailTaken);
    expect(error).toEqual({
      message: AUTH_COPY.register.emailTakenLead,
      link: { href: "/sign-in?next=%2Fcheckout", label: "Sign in instead.", inline: true, handOffEmail: true },
    });
    expect(CHECKOUT_PATH).toBe("/checkout");
  });
});

describe("showFieldSummary", () => {
  it("shows the field summary only while no form-level alert is shown (never two stacked alerts)", () => {
    expect(showFieldSummary(1, null)).toBe(true);
    expect(showFieldSummary(0, null)).toBe(false);
    expect(showFieldSummary(1, emailTakenFormError())).toBe(false);
    expect(showFieldSummary(3, { message: "Something went wrong." })).toBe(false);
  });

  it("is what the checkout view renders, and email_taken uses the single alert", () => {
    const view = readFileSync(join(process.cwd(), "components/checkout/checkout-view.tsx"), "utf8");
    expect(view).toContain("{showFieldSummary(summary.length, formError) ? (");
    expect(view).toMatch(/error\.code === "email_taken"\) \{[\s\S]*?setFormError\(emailTakenFormError\(\)\);/);
    expect(view).toMatch(/onClick=\{link\.handOffEmail \? \(\) => saveSignInPrefill\(email\) : undefined\}/);
  });
});
