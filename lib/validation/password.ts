import { z } from "zod";

export const PASSWORD_MIN = 8;
/** Upper bound keeps argon2 input (and request bodies) small. */
export const PASSWORD_MAX = 128;

/** The one policy message used everywhere (docs/decisions.md). */
export const PASSWORD_ERROR = "Use at least 8 characters with letters and a number.";

/**
 * At least 8 characters (counted as code points), at most 128, with a letter and a digit.
 * Passwords are never trimmed or case-folded.
 */
export function isAcceptablePassword(password: string): boolean {
  if (password.length > PASSWORD_MAX) return false;
  if (Array.from(password).length < PASSWORD_MIN) return false;
  return /\p{L}/u.test(password) && /\d/.test(password);
}

export const passwordSchema = z.string({ error: PASSWORD_ERROR }).refine(isAcceptablePassword, { message: PASSWORD_ERROR });
