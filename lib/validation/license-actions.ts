/**
 * Request validation for the account license actions (api-contracts section 5; decisions.md Phase 4 "Account license
 * actions"): the key reveal and device update bodies (strict, unknown keys rejected), the query strings of the license
 * list and the device fleet, and the shapes of the ids in the URL. Client-safe: the portal forms reuse the schemas.
 */
import { z } from "zod";
import { DERIVED_LICENSE_STATUSES, type DerivedLicenseStatus } from "@/lib/licensing/status";
import { PASSWORD_INPUT_MAX } from "@/lib/validation/auth";

export const DEVICE_NAME_MAX = 80;
export const SEARCH_MAX = 100;
/** Request bodies of these routes are tiny; anything larger is refused before parsing. */
export const LICENSE_ACTION_BODY_MAX_BYTES = 4 * 1024;

/** "LIC-24017"; the human ids come from Counter "license". */
export const LICENSE_ID_RE = /^LIC-[A-Z0-9]{1,32}$/;
/** cuid ids and the seed's readable ids ("seed_dev_d1"). */
export const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Product ids are slugs ("medical-billing"). */
export const PRODUCT_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

export const LICENSE_ACTION_ERRORS = {
  password: "Enter your password.",
  deviceName: "Enter a device name.",
  deviceNameTooLong: `Use ${DEVICE_NAME_MAX} characters or fewer.`,
  deviceNameCharacters: "Use letters, numbers, spaces and punctuation only.",
  location: "Choose one of your locations.",
  nothingToUpdate: "Change the name or the location.",
  status: "Choose a valid status.",
  product: "Choose a valid product.",
  sort: "Choose a valid sort order.",
  search: `Use ${SEARCH_MAX} characters or fewer.`,
} as const;

export function isLicenseIdShape(value: string): boolean {
  return LICENSE_ID_RE.test(value);
}

export function isRecordIdShape(value: string): boolean {
  return RECORD_ID_RE.test(value);
}

/** C0/C1 control characters and the Unicode line/paragraph separators never belong in a display name. */
function hasControlCharacters(value: string): boolean {
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

// ---------- Bodies ----------

/** POST /api/account/licenses/:id/reveal { password }. The password is checked against the stored hash. */
export const revealKeySchema = z.strictObject({
  password: z
    .string({ error: LICENSE_ACTION_ERRORS.password })
    .min(1, { message: LICENSE_ACTION_ERRORS.password })
    .max(PASSWORD_INPUT_MAX, { message: LICENSE_ACTION_ERRORS.password }),
});
export type RevealKeyInput = z.output<typeof revealKeySchema>;

/** Trimmed, NFC-normalised, inner runs of spaces collapsed; 1-80 characters without control characters. */
export const deviceNameSchema = z
  .string({ error: LICENSE_ACTION_ERRORS.deviceName })
  .refine((v) => !hasControlCharacters(v.replace(/[\t\r\n]/g, " ")), { message: LICENSE_ACTION_ERRORS.deviceNameCharacters })
  .transform((v) => v.normalize("NFC").replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(1, { message: LICENSE_ACTION_ERRORS.deviceName })
      .max(DEVICE_NAME_MAX, { message: LICENSE_ACTION_ERRORS.deviceNameTooLong }),
  );

/** A location of the same account, or null to unassign. Ownership is checked on the server. */
export const locationIdSchema = z.union([
  z.null(),
  z.string({ error: LICENSE_ACTION_ERRORS.location }).regex(RECORD_ID_RE, { message: LICENSE_ACTION_ERRORS.location }),
]);

/** PATCH /api/account/devices/:id { name?, locationId? }: at least one of them. */
export const updateDeviceSchema = z
  .strictObject({
    name: deviceNameSchema.optional(),
    locationId: locationIdSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.locationId !== undefined, { message: LICENSE_ACTION_ERRORS.nothingToUpdate });
export type UpdateDeviceInput = z.output<typeof updateDeviceSchema>;

// ---------- Query strings ----------

export const LICENSE_SORT_KEYS = ["product", "status", "expiry", "devices", "updates"] as const;
export type LicenseSortKey = (typeof LICENSE_SORT_KEYS)[number];
export type LicenseStatusFilter = "all" | DerivedLicenseStatus;

export type LicenseListQuery = {
  status: LicenseStatusFilter;
  /** Product id, or "all". */
  product: string;
  /** Trimmed search text ("" = no search): license id, product name or the key's last four characters. */
  q: string;
  /** The prototype's default is expiry ascending. dir 1 = ascending, -1 = descending. */
  sort: { key: LicenseSortKey; dir: 1 | -1 };
};

const searchSchema = z.string().trim().max(SEARCH_MAX, { message: LICENSE_ACTION_ERRORS.search }).default("");

const licenseListQuerySchema = z.strictObject({
  status: z.enum(["all", ...DERIVED_LICENSE_STATUSES], { message: LICENSE_ACTION_ERRORS.status }).default("all"),
  product: z
    .union([z.literal("all"), z.string().regex(PRODUCT_ID_RE)], { message: LICENSE_ACTION_ERRORS.product })
    .default("all"),
  q: searchSchema,
  sort: z
    .string()
    .regex(new RegExp(`^-?(${LICENSE_SORT_KEYS.join("|")})$`), { message: LICENSE_ACTION_ERRORS.sort })
    .default("expiry"),
});

export const DEVICE_STATUS_FILTERS = ["active", "stale", "inactive", "all"] as const;
export type DeviceStatusFilter = (typeof DEVICE_STATUS_FILTERS)[number];

export type DeviceListQuery = {
  /** active (default), stale (active but not seen for 30 days), inactive (deactivated) or all. */
  status: DeviceStatusFilter;
  /** Location id, "none" (unassigned) or "all". */
  location: string;
  /** Trimmed search text: device name, operating system or license id. */
  q: string;
};

const deviceListQuerySchema = z.strictObject({
  status: z.enum(DEVICE_STATUS_FILTERS, { message: LICENSE_ACTION_ERRORS.status }).default("active"),
  location: z
    .union([z.literal("all"), z.literal("none"), z.string().regex(RECORD_ID_RE)], { message: LICENSE_ACTION_ERRORS.location })
    .default("all"),
  q: searchSchema,
});

/** First value of each known parameter; empty values take the default. Unknown parameters are ignored. */
function pick(params: URLSearchParams, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null && value.trim() !== "") out[key] = value;
  }
  return out;
}

/** Parses GET /api/account/licenses?status=&product=&q=&sort= (sort "-key" = descending). Throws ZodError (422). */
export function parseLicenseListQuery(params: URLSearchParams): LicenseListQuery {
  const parsed = licenseListQuerySchema.parse(pick(params, ["status", "product", "q", "sort"]));
  const desc = parsed.sort.startsWith("-");
  return {
    status: parsed.status,
    product: parsed.product,
    q: parsed.q,
    sort: { key: (desc ? parsed.sort.slice(1) : parsed.sort) as LicenseSortKey, dir: desc ? -1 : 1 },
  };
}

/** Parses GET /api/account/devices?status=&location=&q=. Throws ZodError (422). */
export function parseDeviceListQuery(params: URLSearchParams): DeviceListQuery {
  return deviceListQuerySchema.parse(pick(params, ["status", "location", "q"]));
}
