import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type LicenseKeySecrets,
  decryptLicenseKey,
  encryptLicenseKey,
  hashLicenseKey,
  licenseKeyMatchesHash,
  parseEncKey,
  sealLicenseKey,
} from "@/lib/licensing/crypto";
import { generateLicenseKey } from "@/lib/licensing/keys";

const KEY = "MED-7Q4K-9XTP-W2HD-K8NM";
const encKey = randomBytes(32);
const secrets: LicenseKeySecrets = { pepper: "test-pepper-0123456789abcdef", encKey };

/** Flips one bit in the decoded bytes of part `index` and re-encodes it canonically. */
function tamper(payload: string, index: 1 | 2 | 3): string {
  const parts = payload.split(".");
  const buf = Buffer.from(parts[index] ?? "", "base64url");
  buf[0] = (buf[0] ?? 0) ^ 0x01;
  parts[index] = buf.toString("base64url");
  return parts.join(".");
}

describe("parseEncKey", () => {
  it("accepts 32 bytes in base64 and base64url", () => {
    const raw = randomBytes(32);
    expect(parseEncKey(raw.toString("base64")).equals(raw)).toBe(true);
    expect(parseEncKey(raw.toString("base64url")).equals(raw)).toBe(true);
    expect(parseEncKey(`  ${raw.toString("base64")}\n`).equals(raw)).toBe(true);
  });

  it.each([
    ["16 bytes", randomBytes(16).toString("base64")],
    ["33 bytes", randomBytes(33).toString("base64")],
    ["empty", ""],
    ["not base64", "this is not base64!!"],
    ["hex of 32 bytes", randomBytes(32).toString("hex")],
  ])("throws for %s", (_label, value) => {
    expect(() => parseEncKey(value)).toThrow();
  });
});

describe("hashLicenseKey", () => {
  it("is deterministic hex SHA-256 output", () => {
    const a = hashLicenseKey(KEY, secrets.pepper);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLicenseKey(KEY, secrets.pepper)).toBe(a);
  });

  it("hashes the normalised key, so typed variants find the same license", () => {
    const a = hashLicenseKey(KEY, secrets.pepper);
    expect(hashLicenseKey("med7q4k9xtpw2hdk8nm", secrets.pepper)).toBe(a);
    expect(hashLicenseKey(" med-7q4k 9xtp-w2hd-k8nm ", secrets.pepper)).toBe(a);
  });

  it("differs by pepper and by key", () => {
    expect(hashLicenseKey(KEY, "pepper-one")).not.toBe(hashLicenseKey(KEY, "pepper-two"));
    expect(hashLicenseKey(KEY, secrets.pepper)).not.toBe(hashLicenseKey("CHQ-4MRT-H8ZQ-6PWA-J3XV", secrets.pepper));
  });

  it("refuses an empty pepper", () => {
    expect(() => hashLicenseKey(KEY, "")).toThrow();
  });

  it("compares against a stored hash", () => {
    const stored = hashLicenseKey(KEY, secrets.pepper);
    expect(licenseKeyMatchesHash("med7q4k9xtpw2hdk8nm", stored, secrets.pepper)).toBe(true);
    expect(licenseKeyMatchesHash("CHQ-4MRT-H8ZQ-6PWA-J3XV", stored, secrets.pepper)).toBe(false);
    expect(licenseKeyMatchesHash(KEY, "not-a-hash", secrets.pepper)).toBe(false);
  });
});

describe("encryptLicenseKey / decryptLicenseKey", () => {
  it("round-trips", () => {
    const payload = encryptLicenseKey(KEY, encKey);
    expect(payload).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(decryptLicenseKey(payload, encKey)).toBe(KEY);
  });

  it("produces a different ciphertext on every call (random IV)", () => {
    const a = encryptLicenseKey(KEY, encKey);
    const b = encryptLicenseKey(KEY, encKey);
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
    expect(decryptLicenseKey(a, encKey)).toBe(KEY);
    expect(decryptLicenseKey(b, encKey)).toBe(KEY);
  });

  it.each([
    ["iv", 1],
    ["tag", 2],
    ["ciphertext", 3],
  ] as const)("detects tampering with the %s", (_label, index) => {
    const payload = encryptLicenseKey(KEY, encKey);
    expect(() => decryptLicenseKey(tamper(payload, index), encKey)).toThrow();
  });

  it("fails with the wrong key", () => {
    const payload = encryptLicenseKey(KEY, encKey);
    expect(() => decryptLicenseKey(payload, randomBytes(32))).toThrow();
  });

  it("rejects other versions and malformed payloads", () => {
    const payload = encryptLicenseKey(KEY, encKey);
    const [, iv, tag, ct] = payload.split(".");
    expect(() => decryptLicenseKey(`v2.${iv}.${tag}.${ct}`, encKey)).toThrow(/version/);
    expect(() => decryptLicenseKey(`v1.${iv}.${tag}`, encKey)).toThrow();
    expect(() => decryptLicenseKey(`v1.${iv}.${tag}.${ct}.x`, encKey)).toThrow();
    expect(() => decryptLicenseKey(`v1.${iv}.${tag}.${ct}=`, encKey)).toThrow();
    expect(() => decryptLicenseKey(`v1.${iv}.${tag}.`, encKey)).toThrow();
    expect(() => decryptLicenseKey(`v1.${iv}AA.${tag}.${ct}`, encKey)).toThrow();
    expect(() => decryptLicenseKey("", encKey)).toThrow();
  });

  it("refuses encryption keys that are not 32 bytes", () => {
    expect(() => encryptLicenseKey(KEY, randomBytes(16))).toThrow();
    expect(() => decryptLicenseKey(encryptLicenseKey(KEY, encKey), randomBytes(24))).toThrow();
  });

  it("does not reveal the plaintext in error messages", () => {
    const payload = encryptLicenseKey(KEY, encKey);
    try {
      decryptLicenseKey(payload, randomBytes(32));
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(KEY);
    }
  });
});

describe("sealLicenseKey", () => {
  it("returns hash, ciphertext and last4, never the plaintext", () => {
    const key = generateLicenseKey("MED");
    const sealed = sealLicenseKey(key, secrets);
    expect(Object.keys(sealed).sort()).toEqual(["keyCiphertext", "keyHash", "keyLast4"]);
    expect(sealed.keyHash).toBe(hashLicenseKey(key, secrets.pepper));
    expect(sealed.keyLast4).toBe(key.slice(-4));
    expect(decryptLicenseKey(sealed.keyCiphertext, encKey)).toBe(key);
    const serialized = JSON.stringify(sealed);
    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain(key.replace(/-/g, ""));
    // Only the last group may appear (as keyLast4); 4-char checks on random ciphertext could match by chance.
    expect(serialized).not.toContain(key.slice(4, 18));
  });

  it("normalises before sealing", () => {
    const sealed = sealLicenseKey("med7q4k9xtpw2hdk8nm", secrets);
    expect(sealed.keyHash).toBe(hashLicenseKey(KEY, secrets.pepper));
    expect(sealed.keyLast4).toBe("K8NM");
    expect(decryptLicenseKey(sealed.keyCiphertext, encKey)).toBe(KEY);
  });

  it("refuses input that is not a license key", () => {
    expect(() => sealLicenseKey("GST-TRIA-L5HP-8QVM-R2KC", secrets)).toThrow(RangeError);
    expect(() => sealLicenseKey("hello", secrets)).toThrow(RangeError);
  });
});
