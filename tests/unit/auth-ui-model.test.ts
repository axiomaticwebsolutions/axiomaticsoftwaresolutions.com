import { describe, expect, it } from "vitest";
import {
  codeFromPaste,
  continuePath,
  emailPrefill,
  firstName,
  hasErrors,
  initials,
  issuesToFieldErrors,
  passwordStrength,
  retryAfterFrom,
  safeRedirectTarget,
  sanitizeCode,
  serverFieldErrors,
  trialSlug,
  validateCode,
  validateForgot,
  validateRegister,
  validateReset,
  validateSignIn,
  withCreatedFlag,
  withNext,
  withoutCreatedFlag,
} from "@/components/auth/auth-model";

describe("client checks use the prototype copy", () => {
  it("sign in", () => {
    expect(validateSignIn({ email: "", password: "" })).toEqual({
      email: "Enter a valid email address.",
      password: "Enter your password.",
    });
    expect(validateSignIn({ email: " Priya@SharmaMedicals.example ", password: "x" })).toEqual({});
  });

  it("register", () => {
    expect(validateRegister({ name: " ", businessName: "", email: "nope", password: "short1" })).toEqual({
      name: "Enter your name.",
      email: "Enter a valid email address.",
      password: "Use at least 8 characters with letters and a number.",
    });
    expect(validateRegister({ name: "Priya", businessName: "", email: "p@x.example", password: "lettersonly" })).toEqual({
      password: "Use at least 8 characters with letters and a number.",
    });
    expect(validateRegister({ name: "Priya", businessName: "", email: "p@x.example", password: "Medical2026" })).toEqual({});
    expect(validateRegister({ name: "x".repeat(121), businessName: "", email: "p@x.example", password: "Medical2026" }).name).toBe(
      "Use 120 characters or fewer.",
    );
  });

  it("forgot", () => {
    expect(validateForgot({ email: "a@b" })).toEqual({ email: "Enter a valid email address." });
    expect(validateForgot({ email: "a@b.example" })).toEqual({});
  });

  it("reset: policy and match", () => {
    expect(validateReset({ password: "abc", confirm: "abd" })).toEqual({
      password: "Use at least 8 characters with letters and a number.",
      confirm: "Passwords don’t match.",
    });
    expect(validateReset({ password: "Medical2026", confirm: "Medical2026" })).toEqual({});
    expect(validateReset({ password: "Medical2026", confirm: "medical2026" })).toEqual({ confirm: "Passwords don’t match." });
  });

  it("codes", () => {
    expect(validateCode("")).toEqual({ code: "Enter the 6-digit code." });
    expect(validateCode("12345")).toEqual({ code: "Enter the 6-digit code." });
    expect(validateCode("123456")).toEqual({});
  });

  it("hasErrors ignores cleared entries", () => {
    expect(hasErrors({})).toBe(false);
    expect(hasErrors({ email: undefined })).toBe(false);
    expect(hasErrors({ email: "x" })).toBe(true);
  });
});

describe("field error mapping", () => {
  it("keeps the first message per known field", () => {
    const result = {
      success: false as const,
      error: {
        issues: [
          { path: ["email"], message: "first" },
          { path: ["email"], message: "second" },
          { path: ["other"], message: "ignored" },
          { path: [], message: "form" },
        ],
      },
    };
    expect(issuesToFieldErrors(result, ["email", "password"] as const)).toEqual({ email: "first" });
    expect(issuesToFieldErrors({ success: true }, ["email"] as const)).toEqual({});
  });

  it("reads 422 fieldErrors", () => {
    expect(serverFieldErrors({ password: ["Too weak", "x"], token: ["no"] }, ["password", "email"] as const)).toEqual({
      password: "Too weak",
    });
  });
});

describe("code input", () => {
  it("keeps digits only, at most six", () => {
    expect(sanitizeCode("12a3 4-5678")).toBe("123456");
    expect(sanitizeCode("")).toBe("");
  });

  it("pastes whole codes", () => {
    expect(codeFromPaste("482913")).toBe("482913");
    expect(codeFromPaste("482 913")).toBe("482913");
    expect(codeFromPaste("482-913")).toBe("482913");
    expect(codeFromPaste("Your verification code: 482913. It expires in 15 minutes.")).toBe("482913");
    expect(codeFromPaste("Code 482 913 expires in 15 minutes")).toBe("482913");
    expect(codeFromPaste("1234")).toBe("1234");
    expect(codeFromPaste("no digits")).toBe("");
  });
});

describe("password hint", () => {
  it("follows the policy", () => {
    expect(passwordStrength("")).toEqual({ state: "empty", message: "" });
    expect(passwordStrength("abc")).toEqual({ state: "weak", message: "At least 8 characters with letters and a number" });
    expect(passwordStrength("abcdefgh")).toEqual({ state: "weak", message: "At least 8 characters with letters and a number" });
    expect(passwordStrength("abcdefg1")).toEqual({ state: "good", message: "Good password" });
  });
});

describe("next and trial", () => {
  it("accepts product slugs only", () => {
    expect(trialSlug("medical-billing")).toBe("medical-billing");
    expect(trialSlug(" Medical-Billing ")).toBe("medical-billing");
    expect(trialSlug("bad slug")).toBeNull();
    expect(trialSlug("../x")).toBeNull();
    expect(trialSlug("-x")).toBeNull();
    expect(trialSlug(undefined)).toBeNull();
    expect(trialSlug("a".repeat(81))).toBeNull();
  });

  it("folds the trial into next", () => {
    expect(continuePath(null, "medical-billing")).toBe("/account/software?trial=medical-billing");
    expect(continuePath("/account/software", "medical-billing")).toBe("/account/software?trial=medical-billing");
    expect(continuePath("/account/licenses?tab=keys", "pos")).toBe("/account/licenses?tab=keys&trial=pos");
    expect(continuePath("https://evil.example/x", "pos")).toBe("/account/software?trial=pos");
    expect(continuePath("/checkout", "Bad Slug!")).toBe("/checkout");
    expect(continuePath("//evil.example", null)).toBeNull();
    expect(continuePath("/sign-in", null)).toBeNull();
    expect(continuePath(null, null)).toBeNull();
  });

  it("carries a safe next on links", () => {
    expect(withNext("/register", "/account/software?trial=pos")).toBe("/register?next=%2Faccount%2Fsoftware%3Ftrial%3Dpos");
    expect(withNext("/sign-in", "https://evil.example")).toBe("/sign-in");
    expect(withNext("/sign-in", null)).toBe("/sign-in");
  });
});

describe("redirect targets", () => {
  it("allows same-origin paths, including auth pages", () => {
    expect(safeRedirectTarget("/verify?next=%2Fcheckout", "/account")).toBe("/verify?next=%2Fcheckout");
    expect(safeRedirectTarget("/admin", "/account")).toBe("/admin");
    expect(safeRedirectTarget("/sign-in?reset=1", "/account")).toBe("/sign-in?reset=1");
  });

  it("falls back for anything else", () => {
    for (const bad of ["https://evil.example", "//evil.example", `/${String.fromCharCode(92)}evil.example`, "javascript:alert(1)", "/a\nb", "", 42, null]) {
      expect(safeRedirectTarget(bad, "/account")).toBe("/account");
    }
  });

  it("adds and removes the created flag", () => {
    expect(withCreatedFlag("/verify")).toBe("/verify?created=1");
    expect(withCreatedFlag("/verify?next=%2Fcheckout")).toBe("/verify?next=%2Fcheckout&created=1");
    expect(withoutCreatedFlag("/verify?next=%2Fcheckout&created=1")).toBe("/verify?next=%2Fcheckout");
    expect(withoutCreatedFlag("/verify?created=1")).toBe("/verify");
  });
});

describe("small readers", () => {
  it("retryAfterFrom", () => {
    expect(retryAfterFrom({ retryAfterSec: 42 })).toBe(42);
    expect(retryAfterFrom({ retryAfterSec: 0.2 })).toBe(1);
    expect(retryAfterFrom({ retryAfterSec: 99999 })).toBe(3600);
    expect(retryAfterFrom({ retryAfterSec: "42" })).toBeNull();
    expect(retryAfterFrom({})).toBeNull();
  });

  it("emailPrefill", () => {
    expect(emailPrefill(" Priya@SharmaMedicals.example ")).toBe("priya@sharmamedicals.example");
    expect(emailPrefill("not an email")).toBe("");
    expect(emailPrefill(undefined)).toBe("");
  });

  it("names", () => {
    expect(firstName("Priya Sharma")).toBe("Priya");
    expect(firstName("  Sneha  ")).toBe("Sneha");
    expect(initials("Priya Sharma")).toBe("PS");
    expect(initials("Vikram Rao Mehta")).toBe("VM");
    expect(initials("karan")).toBe("K");
    expect(initials(" ")).toBe("?");
  });
});
