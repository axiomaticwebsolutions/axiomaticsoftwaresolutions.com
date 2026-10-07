import { z } from "zod";

/** Indian postal PIN code: exactly six digits. */
export const PIN_RE = /^\d{6}$/;

/** Ten-digit Indian mobile number without prefix (starts with 6-9). */
export const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;

/** Longest phone input we accept before normalising, e.g. "+91 (982) 000-0000" with spacing. */
export const PHONE_INPUT_MAX = 20;

export const EMAIL_MAX = 254;
const EMAIL_LOCAL_MAX = 64;

export const EMAIL_ERROR = "Enter a valid email address.";

// Digits with the usual separators; "+" only at the start, optionally after "(" as in "(+91)".
const PHONE_CHARS_RE = /^\(?\+?[\d\s().-]+$/;

// Dot-atom local part, LDH domain labels, alphabetic-first TLD of 2+ characters. Linear-time patterns.
const EMAIL_RE =
  /^[a-z0-9!#$%&'*+=?^_{|}~-]+(?:\.[a-z0-9!#$%&'*+=?^_{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/i;

/**
 * Accepts "+91 98200 00000", "098200 00000", "0091 9820000000" or "9820000000" and returns the bare
 * ten digits ("9820000000"); null for anything else (letters, landlines, wrong length).
 */
export function normalizeIndianMobile(input: string): string | null {
  const raw = input.trim();
  if (raw.length === 0 || raw.length > PHONE_INPUT_MAX || !PHONE_CHARS_RE.test(raw)) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 14 && digits.startsWith("0091")) digits = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return INDIAN_MOBILE_RE.test(digits) ? digits : null;
}

/** Simple RFC 5321-ish address check on an already trimmed, lower-cased value. */
export function isEmailAddress(value: string): boolean {
  if (value.length > EMAIL_MAX) return false;
  const at = value.lastIndexOf("@");
  if (at < 1 || at > EMAIL_LOCAL_MAX) return false;
  return EMAIL_RE.test(value);
}

/** Email schema with a caller-chosen message (checkout uses its own copy). Output is trimmed and lower-case. */
export function makeEmailSchema(message: string = EMAIL_ERROR) {
  return z.string({ error: message }).trim().toLowerCase().refine(isEmailAddress, { message });
}

/** Trimmed, lower-cased email; one message for every failure: "Enter a valid email address." */
export const emailSchema = makeEmailSchema();

/** Indian mobile schema; output is the bare ten digits. */
export function makeIndianMobileSchema(message: string) {
  return z
    .string({ error: message })
    .refine((v) => normalizeIndianMobile(v) !== null, { message })
    .transform((v) => normalizeIndianMobile(v) ?? v);
}

/** PIN code schema (trimmed, six digits). */
export function makePinSchema(message: string) {
  return z.string({ error: message }).trim().regex(PIN_RE, { message });
}
