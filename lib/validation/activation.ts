/**
 * Request validation for the device activation API (docs/api-contracts.md section 6, docs/activation-api.md):
 * the `X-App-Id` header and the bodies of POST /api/v1/licenses/activate, /validate and /deactivate.
 *
 * Bodies are strict objects (unknown keys -> 422 `validation_failed`). The license key is only bounded here: the
 * service normalises it with normalizeLicenseKey() and answers 404 `invalid_key` for anything that is not a key, so a
 * malformed key and an unknown key look the same. Free text from the device (device name, OS) is cleaned before it
 * is stored or shown in the portal: control characters become spaces, invisible formatting characters (bidi
 * overrides, zero-width characters) are dropped, whitespace is collapsed and key-shaped text is masked.
 * Server-side only (imports the key helpers, which use node:crypto).
 */
import { z } from "zod";
import { MAX_ACTIVATION_TOKEN_LENGTH } from "@/lib/licensing/activation-token";
import { PRODUCT_CODE_RE, redactLicenseKeys } from "@/lib/licensing/keys";

/** Header carrying the product code the app was built for ("MED"). */
export const APP_ID_HEADER = "x-app-id";

/** Input limits (characters, after clean-up). */
export const ACTIVATION_INPUT_MAX = {
  /** A key is 23 characters; leave room for spaces and pasted punctuation that normalisation removes. */
  licenseKey: 64,
  deviceName: 80,
  os: 80,
  appVersion: 32,
  activationToken: MAX_ACTIVATION_TOKEN_LENGTH,
} as const;

/** Raw text above this many characters is refused before clean-up (the cleaned value must fit the limits above). */
const RAW_TEXT_MAX = 400;

/** Body limits for parseJsonBody(): activation bodies are about 300 bytes, tokens are about 400 characters. */
export const ACTIVATE_MAX_BODY_BYTES = 4 * 1024;
export const VALIDATE_MAX_BODY_BYTES = 8 * 1024;
export const DEACTIVATE_MAX_BODY_BYTES = 8 * 1024;

/** SHA-256 hex digest computed on the device from stable hardware identifiers (lower case after parsing). */
export const DEVICE_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/**
 * "4.2", "4.2.1", "4.2.1.1830" (Windows file versions), optionally with a semver pre-release and build suffix
 * ("4.3.0-beta.2+20261007").
 */
export const APP_VERSION_RE =
  /^\d{1,9}(?:\.\d{1,9}){1,3}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const ACTIVATION_FIELD_MESSAGES = {
  licenseKey: "Enter the license key.",
  deviceFingerprint: "Send the device fingerprint as 64 hexadecimal characters (a SHA-256 digest).",
  deviceName: "Enter a name for this computer (up to 80 characters).",
  os: "Send the operating system name (up to 80 characters).",
  appVersion: "Send the app version as numbers separated by dots, such as 4.2.1 (up to 32 characters).",
  activationToken: "Send the activation token this device received when it was activated.",
} as const;

// C0 and C1 control characters (including tabs and line breaks) and DEL.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F]/g;
// Zero-width characters, bidi marks, embeddings, overrides and isolates, word joiners, BOM.
const INVISIBLE_CHARS_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;
// Unpaired UTF-16 surrogates (JSON allows "\ud800"); Postgres text must be valid UTF-8.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Cleans one line of device-supplied text for storage and display. Key-shaped substrings are masked to the product
 * code and last four characters, so a key pasted into the device name never reaches the database in full.
 */
export function cleanDeviceText(value: string): string {
  const cleaned = value
    .replace(LONE_SURROGATE_RE, "\uFFFD")
    .normalize("NFC")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(INVISIBLE_CHARS_RE, "")
    .replace(/\s+/g, " ")
    .trim();
  return redactLicenseKeys(cleaned);
}

/**
 * The product code from the X-App-Id header (trimmed, upper-cased), or null when it is missing or not three
 * letters. The route answers 400 `invalid_app_id` for null.
 */
export function parseAppId(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length > 16) return null;
  const code = value.trim().toUpperCase();
  return PRODUCT_CODE_RE.test(code) ? code : null;
}

const licenseKey = z
  .string({ error: ACTIVATION_FIELD_MESSAGES.licenseKey })
  .max(ACTIVATION_INPUT_MAX.licenseKey, ACTIVATION_FIELD_MESSAGES.licenseKey);

const deviceFingerprint = z
  .string({ error: ACTIVATION_FIELD_MESSAGES.deviceFingerprint })
  .max(RAW_TEXT_MAX, ACTIVATION_FIELD_MESSAGES.deviceFingerprint)
  .trim()
  .toLowerCase()
  .regex(DEVICE_FINGERPRINT_RE, ACTIVATION_FIELD_MESSAGES.deviceFingerprint);

function deviceText(message: string, max: number) {
  return z
    .string({ error: message })
    .max(RAW_TEXT_MAX, message)
    .transform(cleanDeviceText)
    .pipe(z.string().min(1, message).max(max, message));
}

const appVersion = z
  .string({ error: ACTIVATION_FIELD_MESSAGES.appVersion })
  .max(RAW_TEXT_MAX, ACTIVATION_FIELD_MESSAGES.appVersion)
  .trim()
  .max(ACTIVATION_INPUT_MAX.appVersion, ACTIVATION_FIELD_MESSAGES.appVersion)
  .regex(APP_VERSION_RE, ACTIVATION_FIELD_MESSAGES.appVersion);

const activationToken = z
  .string({ error: ACTIVATION_FIELD_MESSAGES.activationToken })
  .trim()
  .min(1, ACTIVATION_FIELD_MESSAGES.activationToken)
  .max(ACTIVATION_INPUT_MAX.activationToken, ACTIVATION_FIELD_MESSAGES.activationToken);

/** POST /api/v1/licenses/activate */
export const activateRequestSchema = z.strictObject({
  licenseKey,
  deviceFingerprint,
  deviceName: deviceText(ACTIVATION_FIELD_MESSAGES.deviceName, ACTIVATION_INPUT_MAX.deviceName),
  os: deviceText(ACTIVATION_FIELD_MESSAGES.os, ACTIVATION_INPUT_MAX.os),
  appVersion,
});

/** POST /api/v1/licenses/validate */
export const validateRequestSchema = z.strictObject({
  activationToken,
  deviceFingerprint,
  appVersion,
});

/** POST /api/v1/licenses/deactivate */
export const deactivateRequestSchema = z.strictObject({
  activationToken,
  deviceFingerprint,
});

export type ActivateRequest = z.output<typeof activateRequestSchema>;
export type ValidateRequest = z.output<typeof validateRequestSchema>;
export type DeactivateRequest = z.output<typeof deactivateRequestSchema>;
