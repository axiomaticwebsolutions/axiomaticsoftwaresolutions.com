/**
 * Encryption at rest of the integration secrets saved in Admin > Settings > Integrations (IntegrationSecret.ciphertext;
 * docs/admin-integrations-design.md section 5, docs/security.md).
 *
 * - Input key material: LICENSE_KEY_ENC_KEY (32 random bytes), passed in by the caller (getLicenseKeySecrets().encKey);
 *   this module never reads process.env.
 * - Key separation: the AES key is HKDF-SHA256(ikm, salt = empty, info = "axs:integration-secrets:v1", 32 bytes), so it
 *   is never the raw env key that seals license keys (lib/licensing/crypto.ts, AAD "axs:license-key:v1").
 * - AES-256-GCM, a fresh random 96-bit IV per write, 128-bit tag. The associated data
 *   "axs:integration-secret:v1:<kind>:<field>" binds a ciphertext to its integration and field: copied to another kind
 *   or field (or opened as a license key) it fails.
 * - Encoding "v1.<iv>.<tag>.<ciphertext>", each part canonical base64url without padding; decoding is strict.
 * - Fail closed: every failure (malformed, unknown version, wrong key, tampered, wrong kind or field) throws the same
 *   IntegrationSecretError with a fixed message and no detail, payload or plaintext.
 * Server code only (node:crypto).
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { SECRET_LAST4_MIN_LENGTH, type IntegrationKind } from "./model";

export const INTEGRATION_SECRET_VERSION = "v1";
export const INTEGRATION_KEY_INFO = "axs:integration-secrets:v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** The one error every failed open throws (no detail on purpose). */
export class IntegrationSecretError extends Error {
  constructor() {
    super("Integration secret could not be decrypted");
    this.name = "IntegrationSecretError";
  }
}

/** HKDF-SHA256 over the 32-byte input key with this module's own info label. Throws unless `ikm` is 32 bytes. */
export function deriveIntegrationKey(ikm: Buffer): Buffer {
  if (!Buffer.isBuffer(ikm) || ikm.length !== KEY_BYTES) throw new Error(`Integration key material must be ${KEY_BYTES} bytes`);
  return Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), INTEGRATION_KEY_INFO, KEY_BYTES));
}

/** "axs:integration-secret:v1:payments:webhookSecret" */
export function integrationSecretAad(kind: IntegrationKind, field: string): Buffer {
  return Buffer.from(`axs:integration-secret:${INTEGRATION_SECRET_VERSION}:${kind}:${field}`, "utf8");
}

/** Seals one secret for `kind` / `field`. A fresh IV every call, so equal plaintexts never give equal ciphertexts. */
export function sealIntegrationSecret(kind: IntegrationKind, field: string, plaintext: string, ikm: Buffer): string {
  if (typeof plaintext !== "string" || plaintext.length === 0) throw new Error("Integration secret is empty");
  const key = deriveIntegrationKey(ikm);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(integrationSecretAad(kind, field));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [INTEGRATION_SECRET_VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

/** Strict base64url: stray characters and non-canonical encodings are refused instead of silently ignored. */
function decodePart(part: string, expectedBytes?: number): Buffer {
  if (!BASE64URL_RE.test(part)) throw new IntegrationSecretError();
  const buf = Buffer.from(part, "base64url");
  if (buf.toString("base64url") !== part) throw new IntegrationSecretError();
  if (expectedBytes !== undefined && buf.length !== expectedBytes) throw new IntegrationSecretError();
  return buf;
}

/** Opens a sealed secret. Throws IntegrationSecretError for any problem; never logs the result. */
export function openIntegrationSecret(kind: IntegrationKind, field: string, payload: string, ikm: Buffer): string {
  let key: Buffer;
  try {
    key = deriveIntegrationKey(ikm);
  } catch {
    throw new IntegrationSecretError();
  }
  if (typeof payload !== "string") throw new IntegrationSecretError();
  const parts = payload.split(".");
  if (parts.length !== 4) throw new IntegrationSecretError();
  const [version, ivPart, tagPart, ctPart] = parts as [string, string, string, string];
  if (version !== INTEGRATION_SECRET_VERSION) throw new IntegrationSecretError();
  const iv = decodePart(ivPart, IV_BYTES);
  const tag = decodePart(tagPart, TAG_BYTES);
  const ciphertext = decodePart(ctPart);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(integrationSecretAad(kind, field));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new IntegrationSecretError();
  }
}

/** The last 4 characters for display, only for secrets of 16 or more characters (else null: the UI shows "Set"). */
export function secretLast4(plaintext: string): string | null {
  const chars = Array.from(plaintext);
  return chars.length >= SECRET_LAST4_MIN_LENGTH ? chars.slice(-4).join("") : null;
}
