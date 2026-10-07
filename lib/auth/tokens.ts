/**
 * Small crypto helpers for opaque tokens, digests and comparisons. All randomness comes from node:crypto.
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** URL-safe random token (`bytes` of entropy, base64url without padding). */
export function randomToken(bytes = 32): string {
  if (!Number.isInteger(bytes) || bytes < 16 || bytes > 1024) throw new RangeError("Token size must be 16-1024 bytes.");
  return randomBytes(bytes).toString("base64url");
}

/** Lower-case hex SHA-256 (session token hashes, verification code hashes, rate-limit identities). */
export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** HMAC-SHA256 as base64url. */
export function hmacSha256(secret: string | Buffer, data: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/**
 * Constant-time string comparison for inputs of any length. Both sides are hashed to equal-length digests
 * first, so neither the content nor the length of the secret leaks through early exits.
 */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const da = createHash("sha256").update(a, "utf8").digest();
  const db = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(da, db);
}

/** Uniform 6-digit code ("004219"), leading zeros kept. */
export function randomSixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
