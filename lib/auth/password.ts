/**
 * argon2id password hashing (OWASP minimum profile: 19 MiB, 2 iterations, 1 lane).
 * Password policy (length, letters + number) lives in lib/validation/password.ts; this module only hashes.
 */
import { randomBytes } from "node:crypto";
import argon2 from "argon2";

export const ARGON2_PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** Inputs longer than this are rejected before hashing so huge bodies cannot burn CPU. */
export const MAX_PASSWORD_LENGTH = 1024;

const ARGON2ID_PREFIX = "$argon2id$";

/** Hashes a password with argon2id. Throws on an empty or oversized password (validate input first). */
export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    throw new RangeError("Password length is outside the accepted range.");
  }
  return argon2.hash(password, { type: argon2.argon2id, ...ARGON2_PARAMS });
}

let dummyHash: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  // Same parameters as real hashes, so a miss costs the same time as a wrong password.
  dummyHash ??= argon2.hash(randomBytes(32).toString("base64url"), { type: argon2.argon2id, ...ARGON2_PARAMS });
  return dummyHash;
}

/**
 * Spends one argon2id verification on a throwaway hash and returns false. Call it when the email is unknown
 * (or the user has no password) so sign-in timing does not reveal which accounts exist.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  try {
    await argon2.verify(await getDummyHash(), password.slice(0, MAX_PASSWORD_LENGTH));
  } catch {
    // Timing equalisation only; the outcome is always false.
  }
  return false;
}

/**
 * Checks a password against a stored hash. Never throws: a missing or malformed hash returns false
 * (after equal work for missing hashes, so sample users without a password look like wrong passwords).
 */
export async function verifyPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (typeof password !== "string" || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  if (!hash || !hash.startsWith("$argon2")) return verifyAgainstDummy(password);
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/** True when the hash is not argon2id or uses older parameters; rehash after a successful sign-in. */
export function needsRehash(hash: string): boolean {
  if (!hash.startsWith(ARGON2ID_PREFIX)) return true;
  try {
    return argon2.needsRehash(hash, ARGON2_PARAMS);
  } catch {
    return true;
  }
}
