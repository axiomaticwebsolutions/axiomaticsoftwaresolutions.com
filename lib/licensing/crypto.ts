/**
 * License key storage: HMAC-SHA256 with a pepper for lookups (License.keyHash), AES-256-GCM for authorised
 * reveals (License.keyCiphertext) and the last four characters for display. Secrets are passed in by the caller
 * (lib/env.ts wires LICENSE_KEY_PEPPER and LICENSE_KEY_ENC_KEY); this module never reads process.env.
 * Server code and scripts only (node:crypto).
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isLicenseKeyFormat, keyLast4, normalizeLicenseKey } from "./keys";

export type LicenseKeySecrets = { pepper: string; encKey: Buffer };
export type SealedLicenseKey = { keyHash: string; keyCiphertext: string; keyLast4: string };

export const LICENSE_KEY_CIPHER_VERSION = "v1";
/** Binds ciphertexts to this purpose and version, so a blob encrypted for something else never decrypts here. */
const AAD = Buffer.from("axs:license-key:v1", "utf8");
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64_RE = /^(?:[A-Za-z0-9+/]+={0,2}|[A-Za-z0-9_-]+)$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const HASH_RE = /^[0-9a-f]{64}$/;

/** Decodes LICENSE_KEY_ENC_KEY (base64 or base64url). Throws unless it is exactly 32 bytes. */
export function parseEncKey(base64: string): Buffer {
  const trimmed = base64.trim();
  if (!BASE64_RE.test(trimmed)) throw new Error("License key encryption key must be base64-encoded");
  const key = Buffer.from(trimmed, trimmed.includes("-") || trimmed.includes("_") ? "base64url" : "base64");
  if (key.length !== KEY_BYTES) throw new Error(`License key encryption key must decode to ${KEY_BYTES} bytes`);
  return key;
}

/** Hex HMAC-SHA256 of the normalised key. Deterministic, so it is the unique lookup column. */
export function hashLicenseKey(key: string, pepper: string): string {
  if (pepper.length === 0) throw new Error("License key pepper is empty");
  return createHmac("sha256", Buffer.from(pepper, "utf8")).update(normalizeLicenseKey(key), "utf8").digest("hex");
}

/** Constant-time check of a key against a stored keyHash. */
export function licenseKeyMatchesHash(key: string, keyHash: string, pepper: string): boolean {
  if (!HASH_RE.test(keyHash)) return false;
  const expected = Buffer.from(keyHash, "hex");
  const actual = Buffer.from(hashLicenseKey(key, pepper), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function assertEncKey(encKey: Buffer): void {
  if (encKey.length !== KEY_BYTES) throw new Error(`License key encryption key must be ${KEY_BYTES} bytes`);
}

/** AES-256-GCM with a fresh random 12-byte IV: "v1.<iv>.<tag>.<ciphertext>", each part base64url. */
export function encryptLicenseKey(key: string, encKey: Buffer): string {
  assertEncKey(encKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encKey, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [LICENSE_KEY_CIPHER_VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Strict base64url: rejects stray characters and non-canonical encodings instead of silently ignoring them. */
function decodePart(part: string, expectedBytes?: number): Buffer {
  if (!BASE64URL_RE.test(part)) throw new Error("License key ciphertext is malformed");
  const buf = Buffer.from(part, "base64url");
  if (buf.toString("base64url") !== part) throw new Error("License key ciphertext is malformed");
  if (expectedBytes !== undefined && buf.length !== expectedBytes) throw new Error("License key ciphertext is malformed");
  return buf;
}

/** Throws on an unknown version, a malformed payload, tampering or the wrong key. Never logs the result. */
export function decryptLicenseKey(payload: string, encKey: Buffer): string {
  assertEncKey(encKey);
  const parts = payload.split(".");
  if (parts.length !== 4) throw new Error("License key ciphertext is malformed");
  const [version, ivPart, tagPart, ctPart] = parts as [string, string, string, string];
  if (version !== LICENSE_KEY_CIPHER_VERSION) throw new Error("Unsupported license key ciphertext version");
  const iv = decodePart(ivPart, IV_BYTES);
  const tag = decodePart(tagPart, TAG_BYTES);
  const ciphertext = decodePart(ctPart);
  try {
    const decipher = createDecipheriv(ALGORITHM, encKey, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // The underlying error carries no useful detail and must not hint at which check failed.
    throw new Error("License key ciphertext could not be decrypted");
  }
}

/** Everything License stores about a key. The plaintext itself is never part of the result. */
export function sealLicenseKey(key: string, secrets: LicenseKeySecrets): SealedLicenseKey {
  const normalized = normalizeLicenseKey(key);
  if (!isLicenseKeyFormat(normalized)) throw new RangeError("Not a license key");
  return {
    keyHash: hashLicenseKey(normalized, secrets.pepper),
    keyCiphertext: encryptLicenseKey(normalized, secrets.encKey),
    keyLast4: keyLast4(normalized),
  };
}
