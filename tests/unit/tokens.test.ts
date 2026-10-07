import { describe, expect, it } from "vitest";
import { hmacSha256, randomSixDigitCode, randomToken, safeEqual, sha256Hex } from "@/lib/auth/tokens";

describe("randomToken", () => {
  it("returns base64url tokens of the requested entropy", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(randomToken(16)).toHaveLength(22);
    expect(new Set(Array.from({ length: 200 }, () => randomToken())).size).toBe(200);
  });

  it("refuses weak or absurd sizes", () => {
    expect(() => randomToken(8)).toThrow(RangeError);
    expect(() => randomToken(1.5)).toThrow(RangeError);
    expect(() => randomToken(4096)).toThrow(RangeError);
  });
});

describe("digests", () => {
  it("sha256Hex matches the FIPS 180-2 vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hmacSha256 matches RFC 4231 test case 2 (as base64url)", () => {
    const expected = Buffer.from("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843", "hex").toString("base64url");
    expect(hmacSha256("Jefe", "what do ya want for nothing?")).toBe(expected);
  });
});

describe("safeEqual", () => {
  it("compares strings of any length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("a".repeat(1000), "a".repeat(1000))).toBe(true);
  });

  it("treats non-strings as unequal", () => {
    expect(safeEqual(undefined as unknown as string, "")).toBe(false);
  });
});

describe("randomSixDigitCode", () => {
  it("always has six digits and keeps leading zeros", () => {
    const codes = Array.from({ length: 3000 }, () => randomSixDigitCode());
    for (const c of codes) expect(c).toMatch(/^[0-9]{6}$/);
    // P(no code below 100000 in 3000 draws) = 0.9^3000, effectively zero.
    expect(codes.some((c) => c.startsWith("0"))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(2900);
  });
});
