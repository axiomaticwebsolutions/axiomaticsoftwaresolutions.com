import { describe, expect, it } from "vitest";
import { accountDestination, ACCOUNT_MENU_COPY, isPrivatePath } from "@/components/auth/account-menu-model";
import { AUTH_ASIDE, AUTH_COPY } from "@/components/auth/copy";
import { snapshotFrom } from "@/components/auth/session-store";
import { AUTH_FIELD_ERRORS } from "@/lib/validation/auth";
import { PASSWORD_ERROR } from "@/lib/validation/password";

describe("auth copy (Account.dc.html)", () => {
  it("keeps the prototype wording", () => {
    expect(AUTH_ASIDE.headline).toBe("Your licenses, downloads and invoices in one place.");
    expect(AUTH_COPY.signIn.subtitle).toBe("Access your licenses, downloads and invoices.");
    expect(AUTH_COPY.register.subtitle).toBe("Bought as a guest? Use the same email and your purchases will appear automatically.");
    expect(AUTH_COPY.register.trialCta).toBe("Create account & start trial");
    expect(AUTH_COPY.verify.subtitle("p@x.example")).toBe("We sent a 6-digit code to p@x.example. It expires in 15 minutes.");
    expect(AUTH_COPY.verify.subtitle(null)).toBe("We sent a 6-digit code to your email. It expires in 15 minutes.");
    expect(AUTH_COPY.forgot.sent("p@x.example")).toBe("If an account exists for p@x.example, a reset link is on its way.");
    expect(AUTH_COPY.reset.subtitle(null)).toBe("For your account. Other sessions will be signed out.");
    expect(AUTH_COPY.signIn.resetNotice).toBe("Password updated. Sign in with your new password.");
    expect(AUTH_COPY.busy).toBe("Please wait…");
  });

  it("agrees with the API's validation messages", () => {
    expect(AUTH_COPY.verify.signedOut).toBe("Sign in again to verify your email.");
    expect(AUTH_FIELD_ERRORS.code).toBe("Enter the 6-digit code.");
    expect(PASSWORD_ERROR).toBe("Use at least 8 characters with letters and a number.");
    expect(`${AUTH_COPY.register.emailTakenLead} ${AUTH_COPY.register.emailTakenLink}`).toBe(
      "An account with this email already exists. Sign in instead.",
    );
  });

  it("formats the resend countdown", () => {
    expect(AUTH_COPY.resendIn(27)).toBe("Resend code in 27s");
  });
});

describe("header account menu", () => {
  it("sends staff to the console and customers to the portal", () => {
    expect(accountDestination({ kind: "STAFF" })).toEqual({ href: "/admin", label: "Admin console" });
    expect(accountDestination({ kind: "CUSTOMER" })).toEqual({ href: "/account", label: "My account" });
  });

  it("knows the private areas", () => {
    expect(isPrivatePath("/account")).toBe(true);
    expect(isPrivatePath("/account/licenses")).toBe(true);
    expect(isPrivatePath("/admin")).toBe(true);
    expect(isPrivatePath("/accounting")).toBe(false);
    expect(isPrivatePath("/software")).toBe(false);
  });

  it("names the menu button after the visible name", () => {
    expect(ACCOUNT_MENU_COPY.menuLabel("Priya")).toBe("Priya, account menu");
  });

  it("reads /api/auth/session bodies", () => {
    expect(snapshotFrom({ user: null, account: null, role: null })).toEqual({ status: "signed-out" });
    expect(snapshotFrom(null)).toEqual({ status: "signed-out" });
    const user = { id: "u1", name: "Priya Sharma", email: "p@x.example", kind: "CUSTOMER" as const, emailVerified: true, staffRole: null };
    expect(snapshotFrom({ user, account: { id: "a1", legalName: "Sharma Medicals" }, role: "OWNER" })).toEqual({
      status: "signed-in",
      user,
      account: { id: "a1", legalName: "Sharma Medicals" },
      role: "OWNER",
    });
  });
});
