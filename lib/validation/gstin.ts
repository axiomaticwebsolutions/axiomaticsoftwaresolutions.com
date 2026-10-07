import { type GstStateName, stateForGstCode } from "@/lib/validation/states";

/**
 * GSTIN checks are format + state-code consistency only. There is deliberately no checksum check:
 * the sample GSTINs used across the product are not checksum-valid (docs/decisions.md).
 */

/** 2-digit state code, 10-character PAN, entity number (1-9/A-Z), "Z", check character. */
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const GSTIN_LENGTH = 15;

/** Upper-cases and removes whitespace, so "27abcde1234f1z5 " and "27 ABCDE 1234F1Z5" both work. */
export function normalizeGstin(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** Format check on the normalised value (does not look at the state code). */
export function isGstinFormat(value: string): boolean {
  return GSTIN_RE.test(normalizeGstin(value));
}

/** Format is valid and the prefix is a GST state code GSTN actually uses (01-38, 97). */
export function isValidGstin(value: string): boolean {
  return gstinStateName(value) !== null;
}

/** "27ABCDE1234F1Z5" -> "Maharashtra"; null when the format or state code is invalid. */
export function gstinStateName(gstin: string): GstStateName | null {
  const normalized = normalizeGstin(gstin);
  if (!GSTIN_RE.test(normalized)) return null;
  return stateForGstCode(normalized.slice(0, 2));
}

/** True when the GSTIN is valid and registered in `state` (legacy codes 25/28 match their current state). */
export function gstinMatchesState(gstin: string, state: string): boolean {
  const registered = gstinStateName(gstin);
  return registered !== null && registered === state;
}
