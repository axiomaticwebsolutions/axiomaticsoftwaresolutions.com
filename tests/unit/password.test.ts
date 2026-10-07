import argon2 from "argon2";
import { describe, expect, it } from "vitest";
import { ARGON2_PARAMS, MAX_PASSWORD_LENGTH, hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from "@/lib/auth/password";

describe("password hashing", () => {
  it("hashes with argon2id at the agreed parameters and a random salt", async () => {
    const a = await hashPassword("Correct-horse1");
    const b = await hashPassword("Correct-horse1");
    expect(a.startsWith("$argon2id$v=19$")).toBe(true);
    // The encoder orders parameters m, p, t; compare them as a set.
    expect(a.split("$")[3]?.split(",").sort()).toEqual(["m=19456", "p=1", "t=2"]);
    expect(a).not.toBe(b);
    expect(a).not.toContain("Correct-horse1");
  });

  it("verifies the right password only", async () => {
    const hash = await hashPassword("Correct-horse1");
    await expect(verifyPassword("Correct-horse1", hash)).resolves.toBe(true);
    await expect(verifyPassword("correct-horse1", hash)).resolves.toBe(false);
    await expect(verifyPassword("", hash)).resolves.toBe(false);
  });

  it("never throws: missing or malformed hashes and oversized input return false", async () => {
    await expect(verifyPassword("Correct-horse1", null)).resolves.toBe(false);
    await expect(verifyPassword("Correct-horse1", undefined)).resolves.toBe(false);
    await expect(verifyPassword("Correct-horse1", "not-a-hash")).resolves.toBe(false);
    await expect(verifyPassword("Correct-horse1", "$argon2id$v=19$m=19456,t=2,p=1$broken")).resolves.toBe(false);
    await expect(verifyPassword("x".repeat(MAX_PASSWORD_LENGTH + 1), await hashPassword("abc12345"))).resolves.toBe(false);
  });

  it("rejects empty and oversized passwords when hashing", async () => {
    await expect(hashPassword("")).rejects.toThrow(RangeError);
    await expect(hashPassword("x".repeat(MAX_PASSWORD_LENGTH + 1))).rejects.toThrow(RangeError);
  });

  it("spends a real verification on unknown users and always answers false", async () => {
    await expect(verifyAgainstDummy("Correct-horse1")).resolves.toBe(false);
    await expect(verifyAgainstDummy("")).resolves.toBe(false);
  });
});

describe("needsRehash", () => {
  it("is false for a fresh hash", async () => {
    expect(needsRehash(await hashPassword("Correct-horse1"))).toBe(false);
  });

  it("is true for older parameters, other argon2 variants and garbage", async () => {
    const weaker = await argon2.hash("Correct-horse1", { type: argon2.argon2id, memoryCost: 8192, timeCost: 2, parallelism: 1 });
    const argon2i = await argon2.hash("Correct-horse1", { type: argon2.argon2i, ...ARGON2_PARAMS });
    expect(needsRehash(weaker)).toBe(true);
    expect(needsRehash(argon2i)).toBe(true);
    expect(needsRehash("garbage")).toBe(true);
    // Old hashes still verify, so sign-in can upgrade them transparently.
    await expect(verifyPassword("Correct-horse1", weaker)).resolves.toBe(true);
  });
});
