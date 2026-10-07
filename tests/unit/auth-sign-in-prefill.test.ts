/**
 * After a password reset, /sign-in keeps the account email (prototype: reset success goes to sign-in with the email
 * and empty password fields). The email travels in sessionStorage ("axiomatic.signInPrefill", read once), never in
 * the URL. The checkout's "Sign in instead." uses the same hand-off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REGISTER_PREFILL_KEY,
  saveRegisterPrefill,
  saveSignInPrefill,
  SIGN_IN_PREFILL_KEY,
  takeRegisterPrefill,
  takeSignInPrefill,
} from "@/components/store/order/session-keys";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("sign-in email hand-off", () => {
  it("stores { v: 1, email } under its own key and reads it once", () => {
    const storage = memoryStorage();
    saveSignInPrefill("priya@sharmamedicals.example", storage);
    expect(JSON.parse(storage.data.get(SIGN_IN_PREFILL_KEY) ?? "null")).toEqual({ v: 1, email: "priya@sharmamedicals.example" });
    expect(takeSignInPrefill(storage)).toBe("priya@sharmamedicals.example");
    expect(takeSignInPrefill(storage)).toBe("");
    expect(storage.data.size).toBe(0);
  });

  it("is separate from the register hand-off", () => {
    const storage = memoryStorage();
    expect(SIGN_IN_PREFILL_KEY).not.toBe(REGISTER_PREFILL_KEY);
    saveRegisterPrefill("a@example.com", storage);
    expect(takeSignInPrefill(storage)).toBe("");
    expect(takeRegisterPrefill(storage)).toBe("a@example.com");
  });

  it("ignores foreign or broken values and blocked storage", () => {
    const storage = memoryStorage();
    storage.data.set(SIGN_IN_PREFILL_KEY, JSON.stringify({ v: 2, email: "x@example.com" }));
    expect(takeSignInPrefill(storage)).toBe("");
    storage.data.set(SIGN_IN_PREFILL_KEY, "{not json");
    expect(takeSignInPrefill(storage)).toBe("");
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => undefined,
    };
    expect(() => saveSignInPrefill("x@example.com", blocked)).not.toThrow();
    expect(takeSignInPrefill(blocked)).toBe("");
    expect(takeSignInPrefill(null)).toBe("");
  });
});

describe("wiring", () => {
  it("the reset form hands the account email over before leaving for /sign-in", () => {
    const reset = source("components/auth/reset-form.tsx");
    expect(reset).toMatch(/saveSignInPrefill\(email\);\s+leaveAuthPage\(res\.redirectTo, "\/sign-in\?reset=1"\);/);
  });

  it("the sign-in form prefills it (validated) unless ?email= already did", () => {
    const signIn = source("components/auth/sign-in-form.tsx");
    expect(signIn).toMatch(/const handed = emailPrefill\(takeSignInPrefill\(\)\);\s+if \(!handed \|\| initialEmail\) return;/);
  });
});
