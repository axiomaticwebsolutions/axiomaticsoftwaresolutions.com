import { describe, expect, it } from "vitest";
import { redirectAfterSignIn, redirectAfterVerification, safeNext, signInPath, verifyPath } from "@/lib/auth/redirect";

const BACKSLASH = String.fromCharCode(92);

describe("safeNext", () => {
  it("keeps same-origin relative paths with query and hash", () => {
    expect(safeNext("/account")).toBe("/account");
    expect(safeNext("/account/software?trial=medical-billing")).toBe("/account/software?trial=medical-billing");
    expect(safeNext("/admin/orders#recent")).toBe("/admin/orders#recent");
    expect(safeNext("  /pricing  ")).toBe("/pricing");
  });

  it("normalises dot segments without leaving the site", () => {
    expect(safeNext("/account/../pricing")).toBe("/pricing");
  });

  it.each([
    ["absolute URL", "https://evil.example/account"],
    ["protocol-relative", "//evil.example"],
    ["backslash host", `/${BACKSLASH}evil.example`],
    ["backslash later", `/account${BACKSLASH}..${BACKSLASH}x`],
    ["javascript scheme", "javascript:alert(1)"],
    ["relative without slash", "account"],
    ["empty", ""],
    ["control character", "/account\nSet-Cookie:x"],
    ["tab", "/acc\tount"],
    ["API route", "/api/me"],
    ["Next internals", "/_next/static/chunk.js"],
    ["auth page", "/sign-in?next=/account"],
    ["auth page subpath", "/reset/anything"],
    ["too long", `/${"a".repeat(2100)}`],
  ])("rejects %s", (_label, value) => {
    expect(safeNext(value)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext(null)).toBeNull();
    expect(safeNext(42)).toBeNull();
    expect(safeNext(["/account"])).toBeNull();
  });
});

describe("redirectAfterSignIn", () => {
  const customer = { kind: "CUSTOMER" as const, emailVerified: true };
  const unverified = { kind: "CUSTOMER" as const, emailVerified: false };
  const staff = { kind: "STAFF" as const, emailVerified: true };

  it("sends verified customers to next or the portal", () => {
    expect(redirectAfterSignIn(customer)).toBe("/account");
    expect(redirectAfterSignIn(customer, "/checkout")).toBe("/checkout");
    expect(redirectAfterSignIn(customer, "https://evil.example")).toBe("/account");
  });

  it("never sends customers into the admin console", () => {
    expect(redirectAfterSignIn(customer, "/admin/orders")).toBe("/account");
  });

  it("sends unverified customers to /verify, keeping next", () => {
    expect(redirectAfterSignIn(unverified)).toBe("/verify");
    expect(redirectAfterSignIn(unverified, "/account/software?trial=x")).toBe(
      `/verify?next=${encodeURIComponent("/account/software?trial=x")}`,
    );
  });

  it("sends staff to /admin unless next is inside the console", () => {
    expect(redirectAfterSignIn(staff)).toBe("/admin");
    expect(redirectAfterSignIn(staff, "/admin/licenses?q=LIC-1")).toBe("/admin/licenses?q=LIC-1");
    expect(redirectAfterSignIn(staff, "/account")).toBe("/admin");
    expect(redirectAfterSignIn(staff, "/administrator")).toBe("/admin");
  });
});

describe("path helpers", () => {
  it("builds verify and sign-in paths with an encoded, validated next", () => {
    expect(verifyPath()).toBe("/verify");
    expect(verifyPath("//evil")).toBe("/verify");
    expect(signInPath("/account/licenses?id=LIC-1")).toBe(`/sign-in?next=${encodeURIComponent("/account/licenses?id=LIC-1")}`);
    expect(signInPath(null)).toBe("/sign-in");
  });

  it("redirectAfterVerification falls back to the portal", () => {
    expect(redirectAfterVerification(null)).toBe("/account");
    expect(redirectAfterVerification("/account/software")).toBe("/account/software");
    expect(redirectAfterVerification("/admin")).toBe("/account");
  });
});
