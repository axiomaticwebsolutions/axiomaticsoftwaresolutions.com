/**
 * Indian states and union territories as offered in the billing form, plus the GST state-code table
 * used to cross-check a GSTIN's two-digit prefix against the selected billing state.
 */

/** The 36 states/UTs in the billing dropdown (same names and order as the prototype's STATES). */
export const INDIAN_STATES = [
  "Andaman and Nicobar Islands",
  "Andhra Pradesh",
  "Arunachal Pradesh",
  "Assam",
  "Bihar",
  "Chandigarh",
  "Chhattisgarh",
  "Dadra and Nagar Haveli and Daman and Diu",
  "Delhi",
  "Goa",
  "Gujarat",
  "Haryana",
  "Himachal Pradesh",
  "Jammu and Kashmir",
  "Jharkhand",
  "Karnataka",
  "Kerala",
  "Ladakh",
  "Lakshadweep",
  "Madhya Pradesh",
  "Maharashtra",
  "Manipur",
  "Meghalaya",
  "Mizoram",
  "Nagaland",
  "Odisha",
  "Puducherry",
  "Punjab",
  "Rajasthan",
  "Sikkim",
  "Tamil Nadu",
  "Telangana",
  "Tripura",
  "Uttar Pradesh",
  "Uttarakhand",
  "West Bengal",
] as const;

export type IndianState = (typeof INDIAN_STATES)[number];

/** GSTN's code for registrations outside any state (e.g. offshore). It is never a billing state. */
export const OTHER_TERRITORY = "Other Territory";

export type GstStateName = IndianState | typeof OTHER_TERRITORY;

/**
 * GST state code -> state/UT name. Complete as of the 2020 Dadra-Daman merger.
 * Legacy codes stay mapped because GSTINs issued under them still appear on old documents:
 * 25 (Daman and Diu, merged into 26) and 28 (Andhra Pradesh before the 2014 split; now 37).
 */
export const GST_STATE_CODES: Readonly<Record<string, GstStateName>> = Object.freeze({
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "25": "Dadra and Nagar Haveli and Daman and Diu",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "28": "Andhra Pradesh",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": OTHER_TERRITORY,
});

/** Codes that are still recognised but never chosen when mapping a state name back to a code. */
export const LEGACY_GST_STATE_CODES: ReadonlySet<string> = new Set(["25", "28"]);

const STATE_SET: ReadonlySet<string> = new Set(INDIAN_STATES);

const CODE_BY_STATE: ReadonlyMap<string, string> = new Map(
  Object.entries(GST_STATE_CODES)
    .filter(([code]) => !LEGACY_GST_STATE_CODES.has(code))
    .map(([code, name]) => [name, code] as const),
);

export function isIndianState(value: unknown): value is IndianState {
  return typeof value === "string" && STATE_SET.has(value);
}

/** "27" (or 27) -> "Maharashtra"; null for codes GSTN does not use. */
export function stateForGstCode(code: string | number): GstStateName | null {
  const key = typeof code === "number" ? String(code).padStart(2, "0") : code.trim();
  if (!/^\d{2}$/.test(key)) return null;
  return Object.hasOwn(GST_STATE_CODES, key) ? (GST_STATE_CODES[key] ?? null) : null;
}

/** "Andhra Pradesh" -> "37" (the current code, never a legacy one); null for unknown names. */
export function gstCodeForState(name: string): string | null {
  return CODE_BY_STATE.get(name) ?? null;
}
