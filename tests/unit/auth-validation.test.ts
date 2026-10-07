import { describe, expect, it } from "vitest";
import {
  changePasswordSchema,
  forgotPasswordSchema,
  registerSchema,
  resetPasswordSchema,
  signInSchema,
  signInVerifySchema,
  verifyEmailSchema,
} from "@/lib/validation/auth";

function messages(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return Object.fromEntries((result.error?.issues ?? []).map((i) => [i.path.map(String).join("."), i.message]));
}

describe("registerSchema", () => {
  it("normalises the email, trims the name and drops an empty business name", () => {
    const out = registerSchema.parse({ name: "  Priya Sharma ", email: " Priya@SharmaMedicals.Example ", password: "Medic1ne!", businessName: "  " });
    expect(out).toEqual({ name: "Priya Sharma", email: "priya@sharmamedicals.example", password: "Medic1ne!", businessName: undefined, next: undefined });
  });

  it("uses the prototype copy for every field", () => {
    const result = registerSchema.safeParse({ name: " ", email: "nope", password: "short" });
    expect(messages(result)).toEqual({
      name: "Enter your name.",
      email: "Enter a valid email address.",
      password: "Use at least 8 characters with letters and a number.",
    });
  });

  it("requires letters and a number in the password", () => {
    expect(registerSchema.safeParse({ name: "A", email: "a@b.example", password: "12345678" }).success).toBe(false);
    expect(registerSchema.safeParse({ name: "A", email: "a@b.example", password: "abcdefgh" }).success).toBe(false);
    expect(registerSchema.safeParse({ name: "A", email: "a@b.example", password: "abcdefg1" }).success).toBe(true);
  });

  it("rejects unknown keys (strict)", () => {
    const result = registerSchema.safeParse({ name: "A", email: "a@b.example", password: "abcdefg1", role: "OWNER" });
    expect(result.success).toBe(false);
  });

  it("keeps a next string and silently drops an oversized one", () => {
    expect(registerSchema.parse({ name: "A", email: "a@b.example", password: "abcdefg1", next: "/account/software" }).next).toBe("/account/software");
    expect(registerSchema.parse({ name: "A", email: "a@b.example", password: "abcdefg1", next: "x".repeat(3000) }).next).toBeUndefined();
    expect(registerSchema.parse({ name: "A", email: "a@b.example", password: "abcdefg1", next: 5 }).next).toBeUndefined();
  });
});

describe("signInSchema", () => {
  it("asks for an email and a password", () => {
    expect(messages(signInSchema.safeParse({ email: "", password: "" }))).toEqual({
      email: "Enter a valid email address.",
      password: "Enter your password.",
    });
  });

  it("does not apply the password policy at sign-in (old passwords still work)", () => {
    expect(signInSchema.safeParse({ email: "a@b.example", password: "x" }).success).toBe(true);
  });

  it("refuses absurdly long passwords before hashing", () => {
    expect(signInSchema.safeParse({ email: "a@b.example", password: "x".repeat(1025) }).success).toBe(false);
  });
});

describe("code schemas", () => {
  it("accepts six digits with spaces and rejects anything else", () => {
    expect(verifyEmailSchema.parse({ code: " 246 810 " }).code).toBe("246810");
    for (const code of ["24681", "2468100", "24681a", "", "２４６８１０"]) {
      expect(messages(verifyEmailSchema.safeParse({ code }))).toEqual({ code: "Enter the 6-digit code." });
    }
  });

  it("defaults trustDevice to false for the two-step check", () => {
    expect(signInVerifySchema.parse({ challengeId: "abc.def", code: "123456" })).toEqual({
      challengeId: "abc.def",
      code: "123456",
      trustDevice: false,
    });
    expect(signInVerifySchema.safeParse({ challengeId: "abc", code: "123456", trustDevice: "yes" }).success).toBe(false);
  });
});

describe("password reset and change", () => {
  it("validates the forgot-password email", () => {
    expect(messages(forgotPasswordSchema.safeParse({ email: "x" }))).toEqual({ email: "Enter a valid email address." });
  });

  it("applies the password policy to the new password only", () => {
    expect(messages(resetPasswordSchema.safeParse({ token: "t", password: "short" }))).toEqual({
      password: "Use at least 8 characters with letters and a number.",
    });
    expect(messages(changePasswordSchema.safeParse({ current: "", next: "abcdefg1" }))).toEqual({
      current: "Enter your current password.",
    });
    expect(changePasswordSchema.safeParse({ current: "anything", next: "abcdefg1" }).success).toBe(true);
  });
});
