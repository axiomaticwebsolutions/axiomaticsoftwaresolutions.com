/**
 * Integration secrets at rest (lib/integrations/crypto.ts; docs/admin-integrations-design.md section 5): HKDF key
 * separation from LICENSE_KEY_ENC_KEY, AES-256-GCM round trip with a random IV, and fail-closed opening.
 */
import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveIntegrationKey,
  INTEGRATION_KEY_INFO,
  IntegrationSecretError,
  openIntegrationSecret,
  sealIntegrationSecret,
  secretLast4,
} from "@/lib/integrations/crypto";
import { encryptLicenseKey } from "@/lib/licensing/crypto";

const ikm = randomBytes(32);
const SECRET = "whsec_RealWebhookSecret_0123456789";

function expectGenericFailure(fn: () => unknown, payload = ""): void {
  let error: unknown = null;
  try {
    fn();
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(IntegrationSecretError);
  const message = (error as Error).message;
  expect(message).toBe("Integration secret could not be decrypted");
  expect(message).not.toContain(SECRET);
  if (payload) expect(message).not.toContain(payload);
}

/** Flips one bit of a base64url part. */
function flip(part: string): string {
  const buf = Buffer.from(part, "base64url");
  buf[0] = (buf[0] ?? 0) ^ 1;
  return buf.toString("base64url");
}

describe("deriveIntegrationKey (HKDF-SHA256, own info label)", () => {
  it("is 32 bytes, deterministic, and neither the input key nor another label's key", () => {
    const a = deriveIntegrationKey(ikm);
    expect(a).toHaveLength(32);
    expect(deriveIntegrationKey(Buffer.from(ikm)).equals(a)).toBe(true);
    expect(a.equals(ikm)).toBe(false);
    expect(INTEGRATION_KEY_INFO).toBe("axs:integration-secrets:v1");
    expect(a.equals(Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), INTEGRATION_KEY_INFO, 32)))).toBe(true);
    expect(a.equals(Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), "axs:license-key:v1", 32)))).toBe(false);
    expect(a.equals(createHmac("sha256", ikm).update(INTEGRATION_KEY_INFO).digest())).toBe(false);
  });

  it("refuses input key material that is not 32 bytes", () => {
    expect(() => deriveIntegrationKey(randomBytes(16))).toThrow();
    expect(() => deriveIntegrationKey(Buffer.alloc(0))).toThrow();
  });
});

describe("seal / open", () => {
  it("round-trips, with a fresh IV every time and the v1 encoding", () => {
    const a = sealIntegrationSecret("payments", "webhookSecret", SECRET, ikm);
    const b = sealIntegrationSecret("payments", "webhookSecret", SECRET, ikm);
    expect(a).not.toBe(b);
    expect(a.split(".")[1]).not.toBe(b.split(".")[1]);
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    expect(a).not.toContain(SECRET);
    expect(openIntegrationSecret("payments", "webhookSecret", a, ikm)).toBe(SECRET);
    expect(openIntegrationSecret("payments", "webhookSecret", b, ikm)).toBe(SECRET);
    const unicode = "pässwörd-₹-🔑";
    expect(openIntegrationSecret("email", "password", sealIntegrationSecret("email", "password", unicode, ikm), ikm)).toBe(unicode);
  });

  it("fails closed with one generic error: wrong key, tampering, wrong kind or field, unknown version, malformed", () => {
    const payload = sealIntegrationSecret("payments", "webhookSecret", SECRET, ikm);
    const [v, iv, tag, ct] = payload.split(".") as [string, string, string, string];
    expectGenericFailure(() => openIntegrationSecret("payments", "webhookSecret", payload, randomBytes(32)), payload);
    expectGenericFailure(() => openIntegrationSecret("payments", "webhookSecret", [v, flip(iv), tag, ct].join("."), ikm));
    expectGenericFailure(() => openIntegrationSecret("payments", "webhookSecret", [v, iv, flip(tag), ct].join("."), ikm));
    expectGenericFailure(() => openIntegrationSecret("payments", "webhookSecret", [v, iv, tag, flip(ct)].join("."), ikm));
    expectGenericFailure(() => openIntegrationSecret("storage", "webhookSecret", payload, ikm), payload);
    expectGenericFailure(() => openIntegrationSecret("payments", "keySecret", payload, ikm), payload);
    expectGenericFailure(() => openIntegrationSecret("payments", "webhookSecret", ["v2", iv, tag, ct].join("."), ikm));
    for (const bad of ["", "v1", "v1...", `${payload}.x`, [v, `${iv}=`, tag, ct].join("."), [v, iv.slice(1), tag, ct].join("."), [v, iv, tag, "a+b/"].join(".")]) {
      expectGenericFailure(() => openIntegrationSecret("payments", "webhookSecret", bad, ikm));
    }
    expectGenericFailure(() => openIntegrationSecret("payments", "webhookSecret", payload, randomBytes(8)));
  });

  it("never opens a license-key ciphertext (same env key, different derivation and associated data)", () => {
    const licenseCiphertext = encryptLicenseKey("MED-ABCD-EFGH-JKLM-NPQR", ikm);
    expectGenericFailure(() => openIntegrationSecret("payments", "keySecret", licenseCiphertext, ikm));
  });

  it("refuses to seal an empty secret", () => {
    expect(() => sealIntegrationSecret("email", "password", "", ikm)).toThrow();
  });
});

describe("secretLast4", () => {
  it("keeps the last 4 characters of secrets of 16 or more characters only", () => {
    expect(secretLast4("a".repeat(15))).toBeNull();
    expect(secretLast4("abcdefghijkl1a2b")).toBe("1a2b");
    expect(secretLast4("short")).toBeNull();
  });
});
