/**
 * License key format: "<CODE>-XXXX-XXXX-XXXX-XXXX", e.g. "MED-7Q4K-9XTP-W2HD-K8NM".
 * The 16 random characters come from a 32-symbol alphabet without I, O, 0 and 1 (80 bits of entropy).
 * Imports node:crypto, so this module is for server code and scripts, not client components.
 */
import { randomInt as cryptoRandomInt } from "node:crypto";

export const LICENSE_KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const LICENSE_KEY_RE = /^[A-Z]{3}(-[A-HJ-NP-Z2-9]{4}){4}$/;
export const PRODUCT_CODE_RE = /^[A-Z]{3}$/;
export const LICENSE_KEY_GROUPS = 4;
export const LICENSE_KEY_GROUP_LENGTH = 4;
/** Length of a canonical key including dashes (23). */
export const LICENSE_KEY_LENGTH = 3 + LICENSE_KEY_GROUPS * (LICENSE_KEY_GROUP_LENGTH + 1);

/** Returns an integer in [0, max). Defaults to node:crypto randomInt; tests may inject a deterministic source. */
export type RandomIntFn = (max: number) => number;

const MASK_GROUP = "\u2022\u2022\u2022\u2022";
/** Code + four groups, dashes optional at group boundaries only. */
const LOOSE_KEY_RE = /^([A-Z0-9]{3})-?([A-Z0-9]{4})-?([A-Z0-9]{4})-?([A-Z0-9]{4})-?([A-Z0-9]{4})$/;
/**
 * Anything key-shaped inside free text: any case, dashes at all four group boundaries or at none, and the groups
 * accept every letter and digit so a mistyped key (with an O or a 0) is still hidden. Over-redaction in logs is
 * acceptable; leaking a key is not. The separators must agree, so hyphenated words and file names such as
 * "license-register-2026-10-07" (no dash after "lic") are left alone.
 */
const KEY_IN_TEXT_RE =
  /(?<![A-Za-z0-9])([A-Za-z]{3})(-?)([A-Za-z0-9]{4})\2([A-Za-z0-9]{4})\2([A-Za-z0-9]{4})\2([A-Za-z0-9]{4})(?![A-Za-z0-9])/g;
/** Hyphen look-alikes that users paste from documents and chat apps. */
const DASH_LOOKALIKES_RE = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;

export function isProductCode(code: string): boolean {
  return PRODUCT_CODE_RE.test(code);
}

/** Generates a fresh key for a product code such as "MED". Throws on an invalid code. */
export function generateLicenseKey(productCode: string, randomInt: RandomIntFn = cryptoRandomInt): string {
  if (!PRODUCT_CODE_RE.test(productCode)) {
    throw new RangeError("Product code must be three upper-case letters (A-Z)");
  }
  const size = LICENSE_KEY_ALPHABET.length;
  let key = productCode;
  for (let g = 0; g < LICENSE_KEY_GROUPS; g += 1) {
    key += "-";
    for (let i = 0; i < LICENSE_KEY_GROUP_LENGTH; i += 1) {
      const n = randomInt(size);
      if (!Number.isInteger(n) || n < 0 || n >= size) {
        throw new RangeError("Random source returned a value outside the alphabet");
      }
      key += LICENSE_KEY_ALPHABET.charAt(n);
    }
  }
  return key;
}

/**
 * Canonicalises user input before hashing or lookup: trims, upper-cases, drops whitespace and accepts the
 * 19 significant characters with or without dashes ("med7q4k9xtpw2hdk8nm" -> "MED-7Q4K-9XTP-W2HD-K8NM").
 * Input that does not have the shape of a key is returned cleaned but otherwise unchanged, so lookups simply miss.
 */
export function normalizeLicenseKey(input: string): string {
  const cleaned = input
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(DASH_LOOKALIKES_RE, "-");
  const m = LOOSE_KEY_RE.exec(cleaned);
  if (!m) return cleaned;
  return [m[1], m[2], m[3], m[4], m[5]].join("-");
}

/** True for a canonical key (upper case, dashes in place). Normalise user input first. */
export function isLicenseKeyFormat(key: string): boolean {
  return LICENSE_KEY_RE.test(key);
}

/** Last four characters of a valid key, stored as License.keyLast4 for display and search. */
export function keyLast4(key: string): string {
  const normalized = normalizeLicenseKey(key);
  if (!LICENSE_KEY_RE.test(normalized)) throw new RangeError("Not a license key");
  return normalized.slice(-LICENSE_KEY_GROUP_LENGTH);
}

/** "MED-••••-••••-••••-K8NM", as the prototype's maskKey(). Never shows more than the last four characters. */
export function maskLicenseKey(productCode: string, last4: string): string {
  return `${productCode}-${MASK_GROUP}-${MASK_GROUP}-${MASK_GROUP}-${last4.slice(-LICENSE_KEY_GROUP_LENGTH)}`;
}

/** Replaces every key-shaped substring with its masked form. Used by the logger and the audit writer. */
export function redactLicenseKeys(text: string): string {
  return text.replace(KEY_IN_TEXT_RE, (_match: string, code: string, _sep: string, _g1: string, _g2: string, _g3: string, g4: string) =>
    maskLicenseKey(code.toUpperCase(), g4.toUpperCase()),
  );
}
