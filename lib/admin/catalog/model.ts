/**
 * Pure helpers of the admin catalog (Admin Console.dc.html products, plans and releases modules): plan labels for
 * the table, drawer and CSV, rupee input parsing, the line formats of the product content editor, installer file
 * names and storage keys, and the derived release status. Client- and server-safe, unit-tested.
 */
import { formatINR, withTax } from "@/lib/money";
import type { StatusTone } from "@/components/admin/model";
import type {
  AdminProductContent,
  BillingIntervalKey,
  CatalogPlatform,
  CatalogTone,
  PlanTypeKey,
  ReleaseRawStatus,
  ReleaseStatusKey,
} from "./types";

export const PLAN_TYPE_LABELS: Readonly<Record<PlanTypeKey, string>> = {
  TRIAL: "Trial",
  ONE_TIME: "One-time",
  ANNUAL: "Annual",
  SUBSCRIPTION: "Subscription",
  DEVICE_ADDON: "Add-on",
  MAINTENANCE: "Maintenance",
};

/** Prototype type badge tones (trial blue, one-time lavender, annual sage, subscription peach, add-on slate, AMC pink). */
export const PLAN_TYPE_TONES: Readonly<Record<PlanTypeKey, StatusTone>> = {
  TRIAL: "blue",
  ONE_TIME: "lavender",
  ANNUAL: "sage",
  SUBSCRIPTION: "peach",
  DEVICE_ADDON: "slate",
  MAINTENANCE: "pink",
};

/** URL filter values for plan types (lower case, like the prototype's TYPE keys). */
export const PLAN_TYPE_FILTERS = ["trial", "one_time", "annual", "subscription", "device_addon", "maintenance"] as const;
export type PlanTypeFilter = (typeof PLAN_TYPE_FILTERS)[number];

export function planTypeFromFilter(value: string): PlanTypeKey | null {
  const upper = value.toUpperCase();
  return (Object.keys(PLAN_TYPE_LABELS) as PlanTypeKey[]).includes(upper as PlanTypeKey) ? (upper as PlanTypeKey) : null;
}

export const PLATFORM_LABELS: Readonly<Record<CatalogPlatform, string>> = { windows: "Windows", macos: "macOS", android: "Android" };

export function platformList(platforms: readonly CatalogPlatform[], separator = ", "): string {
  return platforms.map((p) => PLATFORM_LABELS[p]).join(separator);
}

export const TONE_LABELS: Readonly<Record<CatalogTone, string>> = {
  sage: "Sage",
  peach: "Peach",
  blue: "Blue",
  lavender: "Lavender",
  pink: "Pink",
};

type PlanShape = {
  type: PlanTypeKey;
  pricePaise: number;
  interval: BillingIntervalKey | null;
  trialDays: number | null;
  deviceLimit: number | null;
  perUnit: string | null;
  maxQty: number | null;
  multiDevice: boolean;
  updatesMonths: number | null;
};

/** Table badge: "Multi-device" for multi-device plans, else the type. */
export function planTypeBadge(plan: Pick<PlanShape, "type" | "multiDevice">): { label: string; tone: StatusTone } {
  return { label: plan.multiDevice ? "Multi-device" : PLAN_TYPE_LABELS[plan.type], tone: PLAN_TYPE_TONES[plan.type] };
}

/** Table TERM: "15 days", "Per year", "Per month", "Perpetual". */
export function planTermLabel(plan: Pick<PlanShape, "type" | "interval" | "trialDays">): string {
  if (plan.type === "TRIAL") return `${plan.trialDays ?? 0} days`;
  if (plan.interval === "YEAR") return "Per year";
  if (plan.interval === "MONTH") return "Per month";
  return "Perpetual";
}

/** Drawer Term: "15 days", "1 year", "1 month", "Perpetual". */
export function planTermDetail(plan: Pick<PlanShape, "type" | "interval" | "trialDays">): string {
  if (plan.type === "TRIAL") return `${plan.trialDays ?? 0} days`;
  if (plan.interval === "YEAR") return "1 year";
  if (plan.interval === "MONTH") return "1 month";
  return "Perpetual";
}

/** Table DEVICE LIMIT: "Per terminal (max 10)", "3", "Attaches to license". */
export function planDeviceLimitLabel(plan: Pick<PlanShape, "perUnit" | "maxQty" | "deviceLimit">): string {
  if (plan.perUnit) return `Per ${plan.perUnit} (max ${plan.maxQty ?? 10})`;
  return plan.deviceLimit ? String(plan.deviceLimit) : "Attaches to license";
}

/** Table UPDATES: "12 months", "+12 months" (maintenance), "During term". */
export function planUpdatesLabel(plan: Pick<PlanShape, "type" | "updatesMonths">): string {
  if (plan.type === "MAINTENANCE") return `+${plan.updatesMonths ?? 12} months`;
  if (plan.updatesMonths) return `${plan.updatesMonths} months`;
  return "During term";
}

/** Drawer "Expiry behaviour" (prototype copy). */
export function planExpiryBehaviour(type: PlanTypeKey): string {
  if (type === "ONE_TIME") return "Keeps working; updates stop";
  if (type === "TRIAL") return "Stops creating bills";
  return "Stops creating bills; data kept";
}

/** Table PRICE: "₹4,999" or "Free", and the incl.-GST line ("incl. GST ₹5,898.82") for paid plans. */
export function planPriceLines(pricePaise: number, gstRatePct: number): { price: string; inclGst: string | null } {
  if (pricePaise <= 0) return { price: "Free", inclGst: null };
  return { price: formatINR(pricePaise), inclGst: `incl. GST ${formatINR(withTax(pricePaise, gstRatePct))}` };
}

// ---------- Rupee inputs ----------

const RUPEES_RE = /^[0-9]{1,8}(?:[.][0-9]{1,2})?$/;

/** "4,999", "₹4999.5" or "4999.50" -> paise (exact, no floating point); null when it is not a valid amount. */
export function parseRupeesToPaise(input: string): number | null {
  const cleaned = input.replace(/[\u20B9,\s]/g, "");
  if (!RUPEES_RE.test(cleaned)) return null;
  const [whole = "0", fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

/** Paise as the price field shows it: "4999" or "4999.50". */
export function paiseToRupeesInput(paise: number): string {
  const whole = Math.trunc(paise / 100);
  const rest = paise % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, "0")}`;
}

// ---------- Product content editor (one item per line, parts separated by "|") ----------

export type LineIssue = { line: number; message: string };
export type ParsedLines<T> = { items: T[]; issues: LineIssue[] };

export const CONTENT_LINE_HINTS = {
  features: "One feature per line: icon | title | description",
  benefits: "One benefit per line: title | description",
  requirements: "One requirement per line: label | value",
} as const;

function splitLines(text: string): { line: number; parts: string[] }[] {
  return text
    .split(/\r?\n/)
    .map((raw, i) => ({ line: i + 1, parts: raw.split("|").map((p) => p.trim()) }))
    .filter((row) => row.parts.some((p) => p !== ""));
}

/** Joins the parts after the first `head` ones back together ("|" inside a description survives). */
function tail(parts: string[], head: number): string {
  return parts.slice(head).join(" | ").trim();
}

export function parseFeatureLines(text: string): ParsedLines<AdminProductContent["features"][number]> {
  const items: AdminProductContent["features"] = [];
  const issues: LineIssue[] = [];
  for (const { line, parts } of splitLines(text)) {
    const [icon = "", title = ""] = parts;
    const body = tail(parts, 2);
    if (!icon || !title || !body) issues.push({ line, message: `Line ${line}: use icon | title | description.` });
    else items.push({ icon, title, body });
  }
  return { items, issues };
}

export function parseBenefitLines(text: string): ParsedLines<AdminProductContent["benefits"][number]> {
  const items: AdminProductContent["benefits"] = [];
  const issues: LineIssue[] = [];
  for (const { line, parts } of splitLines(text)) {
    const [title = ""] = parts;
    const body = tail(parts, 1);
    if (!title || !body) issues.push({ line, message: `Line ${line}: use title | description.` });
    else items.push({ title, body });
  }
  return { items, issues };
}

export function parseRequirementLines(text: string): ParsedLines<AdminProductContent["requirements"][number]> {
  const items: AdminProductContent["requirements"] = [];
  const issues: LineIssue[] = [];
  for (const { line, parts } of splitLines(text)) {
    const [label = ""] = parts;
    const value = tail(parts, 1);
    if (!label || !value) issues.push({ line, message: `Line ${line}: use label | value.` });
    else items.push({ label, value });
  }
  return { items, issues };
}

export function formatFeatureLines(items: AdminProductContent["features"]): string {
  return items.map((f) => `${f.icon} | ${f.title} | ${f.body}`).join("\n");
}

export function formatBenefitLines(items: AdminProductContent["benefits"]): string {
  return items.map((b) => `${b.title} | ${b.body}`).join("\n");
}

export function formatRequirementLines(items: AdminProductContent["requirements"]): string {
  return items.map((r) => `${r.label} | ${r.value}`).join("\n");
}

/** Lenient read of Product.content for the editor (missing or malformed parts become empty lists). */
export function readProductContent(value: unknown): AdminProductContent {
  const v = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const list = (key: string) => (Array.isArray(v[key]) ? (v[key] as unknown[]) : []);
  const str = (o: unknown, key: string) => {
    const x = o !== null && typeof o === "object" ? (o as Record<string, unknown>)[key] : undefined;
    return typeof x === "string" ? x : "";
  };
  return {
    features: list("features").map((f) => ({ icon: str(f, "icon"), title: str(f, "title"), body: str(f, "body") })),
    benefits: list("benefits").map((b) => ({ title: str(b, "title"), body: str(b, "body") })),
    requirements: list("requirements").map((r) => ({ label: str(r, "label"), value: str(r, "value") })),
  };
}

// ---------- Releases ----------

/** The list status: drafts and withdrawn releases as stored; a published release is "latest" when it is its product's newest. */
export function releaseStatusKey(raw: ReleaseRawStatus, isLatest: boolean): ReleaseStatusKey {
  if (raw === "DRAFT") return "draft";
  if (raw === "WITHDRAWN") return "withdrawn";
  return isLatest ? "latest" : "published";
}

export const RELEASE_STATUS_FILTERS = ["latest", "published", "draft", "withdrawn"] as const;

export const RELEASE_CHANNEL_LABELS: Readonly<Record<string, string>> = { stable: "Stable", beta: "Beta" };

export function releaseChannelLabel(channel: string): string {
  return RELEASE_CHANNEL_LABELS[channel] ?? channel.charAt(0).toUpperCase() + channel.slice(1);
}

/** Allowed installer extensions per platform. */
export const INSTALLER_EXTENSIONS: Readonly<Record<CatalogPlatform, readonly string[]>> = {
  windows: [".exe", ".msi", ".zip"],
  macos: [".dmg", ".pkg", ".zip"],
  android: [".apk"],
};

export function installerExtensionError(platform: CatalogPlatform, fileName: string): string | null {
  const lower = fileName.trim().toLowerCase();
  const allowed = INSTALLER_EXTENSIONS[platform];
  if (allowed.some((ext) => lower.endsWith(ext))) return null;
  const list = allowed.length === 1 ? allowed[0] : `${allowed.slice(0, -1).join(", ")} or ${allowed[allowed.length - 1]}`;
  return `${PLATFORM_LABELS[platform]} installers are ${list} files.`;
}

/** Characters a storage key segment may hold ([A-Za-z0-9._-], starting with a letter or digit). */
function keySegment(value: string, fallback: string): string {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 120)
    .replace(/[-.]+$/, "");
  return cleaned || fallback;
}

/**
 * The installer's download name: the uploaded file's base name (any folder part dropped) with each run of unsafe
 * characters replaced by one hyphen and the extension kept: "Medical Store 4.2.1 (x64).exe" -> "Medical-Store-4.2.1-x64.exe".
 */
export function safeInstallerName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "";
  const safeStem = keySegment(stem, "installer").replace(/[-.]+$/, "") || "installer";
  return ext ? `${safeStem}.${ext}` : safeStem;
}

/** Private storage prefix of a release: "releases/<product>/<version>/". */
export function releaseStoragePrefix(productId: string, version: string): string {
  return `releases/${keySegment(productId, "product")}/${keySegment(version, "version")}/`;
}

/** Object key for one upload: a random segment keeps a replaced installer from overwriting the previous object. */
export function installerStorageKey(productId: string, version: string, nonce: string, safeName: string): string {
  return `${releaseStoragePrefix(productId, version)}${keySegment(nonce, "upload")}/${safeName}`;
}

/** "8bb3f33bfc71…" */
export function shortSha256(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}\u2026` : sha;
}
