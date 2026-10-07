/**
 * View model of the portal license pages (Customer Portal prototype views "Licenses" and "License detail"): list
 * filters and sorts, term and device-usage cells, CSV columns, the status explanation, the facts grid, the
 * "Renew & upgrade" cards and the cart lines they add. Pure and client-safe (no React), so unit tests cover it.
 *
 * Dates are formatted in IST from a `now` the server sends with the data, so the server render and the browser agree.
 */
import type { BillingInterval, PlanType } from "@/generated/prisma/enums";
import type { IconSourceName } from "@/components/icons/icon-names";
import { matchesQuery } from "@/components/data-table/model";
import type { DataTableOption } from "@/components/data-table/types";
import type { CsvColumn } from "@/lib/csv";
import { DAY_MS, formatDateIST, istParts } from "@/lib/dates";
import type { Tone } from "@/lib/design/tokens";
import type { AccountLicenseRow, LicenseHistoryEntry, RenewalOption } from "@/lib/licensing/account";
import { EXPIRING_DAYS, LICENSE_STATUS_META, type DerivedLicenseStatus } from "@/lib/licensing/status";
import { DEFAULT_MAX_QTY } from "@/lib/pricing";
import { defineListState, type ListSort } from "@/lib/url-state";

// ---------- Cart lines ----------

export type CartLineKind = "RENEWAL" | "UPGRADE" | "ADDON";

/** A cart line for an existing license (lib/cart/store add(planId, { qty, maxQty, kind, targetLicenseId })). */
export type CartLineSpec = { planId: string; qty: number; maxQty: number; kind: CartLineKind; targetLicenseId: string };

/** Quantity cap of a plan in the cart, as the server's normalizeQuantity(): add-ons and per-unit plans, else 1. */
export function cartMaxQty(plan: { type: PlanType; perUnit: string | null; maxQty: number | null }): number {
  if (plan.type === "MAINTENANCE") return 1;
  if (plan.type === "DEVICE_ADDON" || plan.perUnit) return Math.max(1, plan.maxQty ?? DEFAULT_MAX_QTY);
  return 1;
}

/** The cart line of a "Renew & upgrade" option (the cart re-prices everything on the server). */
export function optionLine(
  option: Pick<RenewalOption, "planId" | "qty" | "kind">,
  licenseId: string,
  plan: { type: PlanType; perUnit: string | null; maxQty: number | null } | null,
): CartLineSpec {
  const max = plan ? cartMaxQty(plan) : option.qty;
  return { planId: option.planId, qty: option.qty, maxQty: Math.max(option.qty, max), kind: option.kind, targetLicenseId: licenseId };
}

/** The option a license's "Renew" adds: renewal, maintenance, or a trial's conversion (Overview "primaryRenewal"). */
export function primaryOption<O extends Pick<RenewalOption, "tag">>(options: readonly O[]): O | null {
  return options.find((o) => o.tag === "RENEWAL" || o.tag === "MAINTENANCE" || o.tag === "BUY") ?? null;
}

// ---------- License list ----------

/** A license row plus the renewal line "Renew selected" adds (null when it cannot be renewed here). */
export type LicenseListRow = AccountLicenseRow & { renewal: CartLineSpec | null };

export const LICENSE_STATUS_FILTERS = ["active", "expiring", "trial", "expired", "suspended", "revoked"] as const;
export const LICENSE_SORT_IDS = ["product", "status", "expiry", "devices", "updates"] as const;
/** Rows per page; smaller lists show every row with the prototype footer. */
export const LICENSES_PAGE_SIZE = 50;

/** URL state of the license list: ?q=&status=&product=&sort=(-)expiry&page= (defaults left out). */
export const LICENSES_LIST = defineListState({
  filters: { status: { values: LICENSE_STATUS_FILTERS }, product: {} },
  sortable: LICENSE_SORT_IDS,
  defaultSort: { id: "expiry", desc: false },
  pageSize: LICENSES_PAGE_SIZE,
});

/** Status filter options in prototype order; "Suspended" only when the account has a suspended license. */
export function licenseStatusOptions(rows: readonly { status: DerivedLicenseStatus }[]): DataTableOption[] {
  const options: DataTableOption[] = [{ value: "all", label: "All" }];
  for (const status of ["active", "expiring", "trial", "expired", "revoked"] as const) {
    options.push({ value: status, label: LICENSE_STATUS_META[status].label });
  }
  if (rows.some((r) => r.status === "suspended")) options.push({ value: "suspended", label: LICENSE_STATUS_META.suspended.label });
  return options;
}

export function licenseProductOptions(products: readonly { id: string; shortName: string }[]): DataTableOption[] {
  return [{ value: "all", label: "All products" }, ...products.map((p) => ({ value: p.id, label: p.shortName }))];
}

export type LicenseFilters = { q: string; status: string; product: string };

/** Status, product and search (license id, product name or the key's last four), as the prototype. */
export function filterLicenses<R extends AccountLicenseRow>(rows: readonly R[], f: LicenseFilters): R[] {
  return rows.filter(
    (r) =>
      (f.status === "all" || r.status === f.status) &&
      (f.product === "all" || r.productId === f.product) &&
      matchesQuery(f.q, [r.id, r.productName, r.productShortName, r.keyLast4]),
  );
}

/** Status column order: working licenses first, then the ones that need attention. */
const STATUS_RANK: Record<DerivedLicenseStatus, number> = { active: 0, expiring: 1, trial: 2, expired: 3, suspended: 4, revoked: 5 };

const SORT_VALUE: Record<(typeof LICENSE_SORT_IDS)[number], (row: AccountLicenseRow) => number | string> = {
  product: (row) => row.productShortName.toLowerCase(),
  status: (row) => STATUS_RANK[row.status],
  // Licenses without an end date sort last ascending (and first descending), as in the prototype and the API.
  expiry: (row) => (row.expiresAt ? Date.parse(row.expiresAt) : Number.POSITIVE_INFINITY),
  devices: (row) => (row.deviceLimit > 0 ? row.devicesUsed / row.deviceLimit : 0),
  updates: (row) => Date.parse(row.updatesUntil),
};

function isSortId(id: string): id is (typeof LICENSE_SORT_IDS)[number] {
  return (LICENSE_SORT_IDS as readonly string[]).includes(id);
}

/** The prototype's column sorts (default expiry ascending); ties by license id. */
export function sortLicenses<R extends AccountLicenseRow>(rows: readonly R[], sort: ListSort | null): R[] {
  const id = sort && isSortId(sort.id) ? sort.id : "expiry";
  const dir = sort && isSortId(sort.id) && sort.desc ? -1 : 1;
  const value = SORT_VALUE[id];
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const byValue = x > y ? 1 : x < y ? -1 : 0;
    if (byValue !== 0) return byValue * dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export function daysText(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

/** TERM cell: end date and "41 days left" / "Ended 25 days ago" (peach under 60 days) / "One-time license". */
export function termInfo(expiresAt: string | null, now: Date): { label: string; sub: string; warn: boolean } {
  if (!expiresAt) return { label: "No end date", sub: "One-time license", warn: false };
  const end = new Date(expiresAt);
  const diff = end.getTime() - now.getTime();
  if (diff <= 0) {
    const ago = Math.floor(-diff / DAY_MS);
    return { label: formatDateIST(end), sub: ago === 0 ? "Ended today" : `Ended ${daysText(ago)} ago`, warn: true };
  }
  const left = Math.ceil(diff / DAY_MS);
  return { label: formatDateIST(end), sub: `${daysText(left)} left`, warn: left < EXPIRING_DAYS };
}

/** DEVICES cell: "2 / 3" with a bar that turns orange when every slot is used. */
export function deviceUsage(used: number, limit: number): { label: string; pct: number; full: boolean } {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 1000) / 10) : 0;
  return { label: `${used} / ${limit}`, pct, full: limit > 0 && used >= limit };
}

/** "2026-11-17" in IST: spreadsheet-friendly dates for CSV files (the orders CSV does the same). */
export function istIsoDate(value: string | Date | null): string {
  if (!value) return "";
  const p = istParts(typeof value === "string" ? new Date(value) : value);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export const LICENSES_CSV_FILE = "licenses.csv";

/** licenses.csv in the prototype's column order; status as its label, dates as IST YYYY-MM-DD. */
export const LICENSE_CSV_COLUMNS: readonly CsvColumn<AccountLicenseRow>[] = [
  { header: "License", value: (l) => l.id },
  { header: "Product", value: (l) => l.productName },
  { header: "Plan", value: (l) => l.planName },
  { header: "Status", value: (l) => LICENSE_STATUS_META[l.status].label },
  { header: "Expires", value: (l) => (l.expiresAt ? istIsoDate(l.expiresAt) : "No end date") },
  { header: "Updates until", value: (l) => istIsoDate(l.updatesUntil) },
  { header: "Devices used", value: (l) => l.devicesUsed },
  { header: "Device limit", value: (l) => l.deviceLimit },
  { header: "Key (last 4)", value: (l) => l.keyLast4 },
];

/** Footer: "4 of 6 licenses · keys are masked; open a license to reveal". */
export function licensesFooter(shown: number, total: number): string {
  return `${shown.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")} ${total === 1 ? "license" : "licenses"} · keys are masked; open a license to reveal`;
}

/** Bulk "Renew selected": the lines to add and how many selected licenses cannot be renewed here (revoked). */
export function renewalSelection(rows: readonly LicenseListRow[], selected: readonly string[]): { lines: CartLineSpec[]; skipped: number } {
  const ids = new Set(selected);
  const chosen = rows.filter((r) => ids.has(r.id));
  const lines = chosen.flatMap((r) => (r.renewal && r.status !== "revoked" ? [r.renewal] : []));
  return { lines, skipped: chosen.length - lines.length };
}

// ---------- License detail ----------

export const LICENSE_TABS = ["overview", "devices", "activity", "renew"] as const;
export type LicenseTab = (typeof LICENSE_TABS)[number];

export function parseLicenseTab(value: string | string[] | null | undefined): LicenseTab {
  const v = Array.isArray(value) ? value[0] : value;
  return v && (LICENSE_TABS as readonly string[]).includes(v) ? (v as LicenseTab) : "overview";
}

/** /account/licenses/LIC-24017?tab=devices (overview is the default and stays out of the URL). */
export function licenseHref(id: string, tab: LicenseTab = "overview"): string {
  const path = `/account/licenses/${encodeURIComponent(id)}`;
  return tab === "overview" ? path : `${path}?tab=${tab}`;
}

/** Plan type sub-label of the PLAN fact (prototype LICENSE_TYPES). */
export const PLAN_TYPE_LABELS: Record<PlanType, string> = {
  TRIAL: "Free trial",
  ONE_TIME: "One-time",
  ANNUAL: "Annual",
  SUBSCRIPTION: "Subscription",
  MAINTENANCE: "Maintenance",
  DEVICE_ADDON: "Add-on",
};

/** "3 computers", "1 terminal". */
export function countNoun(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** The license fields the explanation, facts and cards read (AccountLicenseDetail["license"]). */
export type DetailLicense = Pick<
  AccountLicenseRow,
  "id" | "productShortName" | "planName" | "planType" | "status" | "issuedAt" | "expiresAt" | "updatesUntil" | "deviceLimit" | "devicesUsed" | "orderId"
> & { unit: string; revokedReason: string | null; selfServiceResetsLeft: number; selfServiceResetsPerYear: number };

export function isTrialLicense(license: { planType: PlanType }): boolean {
  return license.planType === "TRIAL";
}

export type Explanation = { tone: Tone; icon: IconSourceName; title: string; body: string };

/** The tinted callout on the Overview tab, in the prototype's words per derived status. */
export function statusExplanation(l: DetailLicense, now: Date): Explanation {
  const meta = LICENSE_STATUS_META[l.status];
  const lim = countNoun(l.deviceLimit, l.unit);
  const end = l.expiresAt ? formatDateIST(new Date(l.expiresAt)) : "";
  const updates = formatDateIST(new Date(l.updatesUntil));
  const base = { tone: meta.tone, icon: meta.icon };
  switch (l.status) {
    case "active": {
      if (l.expiresAt) {
        return { ...base, title: "What this license covers", body: `You can use ${l.productShortName} on up to ${lim} until ${end}. Updates and support are included until then.` };
      }
      const ended = Date.parse(l.updatesUntil) <= now.getTime();
      const tail = ended
        ? `Updates ended on ${updates}; the software keeps working, and you can renew maintenance for newer versions.`
        : `Updates are included until ${updates}.`;
      return { ...base, title: "What this license covers", body: `You can use ${l.productShortName} on up to ${lim} with no end date. ${tail}` };
    }
    case "expiring": {
      const left = l.expiresAt ? Math.max(1, Math.ceil((Date.parse(l.expiresAt) - now.getTime()) / DAY_MS)) : 0;
      return {
        ...base,
        title: `Ends in ${daysText(left)}`,
        body: `You can use ${l.productShortName} on up to ${lim} until ${end}. Renew before then to keep billing without a break. Your data stays on your computers either way.`,
      };
    }
    case "expired": {
      const trial = isTrialLicense(l);
      return {
        ...base,
        title: trial ? "Trial ended" : "License expired",
        body: `It ended on ${end}. The software can no longer create new bills, but your data is safe. ${trial ? "Buy a license to continue." : "Renew to continue where you left off."}`,
      };
    }
    case "revoked": {
      const reason = l.revokedReason?.trim();
      return {
        ...base,
        title: "License revoked",
        body: `${reason ? `${reason} ` : ""}It can’t be activated on any computer. Contact support if you think this is a mistake.`,
      };
    }
    case "suspended":
      return { ...base, title: "License suspended", body: "Activations are paused. Contact support to restore it." };
    case "trial":
      return { ...base, title: "Free trial", body: end ? `All features on ${lim} until ${end}.` : `All features on ${lim}.` };
  }
}

export type LicenseFact = { key: string; label: string; value: string; sub: string; orderId?: string };

/** The facts grid: plan, issued, valid until / ended, updates until, device limit, self-service resets. */
export function licenseFacts(l: DetailLicense, now: Date): LicenseFact[] {
  const updatesEnded = Date.parse(l.updatesUntil) <= now.getTime();
  return [
    { key: "plan", label: "Plan", value: l.planName, sub: PLAN_TYPE_LABELS[l.planType] },
    {
      key: "issued",
      label: "Issued",
      value: formatDateIST(new Date(l.issuedAt)),
      sub: l.orderId ? `Order ${l.orderId}` : isTrialLicense(l) ? "Trial" : "",
      ...(l.orderId ? { orderId: l.orderId } : {}),
    },
    {
      key: "end",
      label: l.status === "expired" ? "Ended" : "Valid until",
      value: l.expiresAt ? formatDateIST(new Date(l.expiresAt)) : "No end date",
      sub: l.expiresAt ? "" : "One-time license",
    },
    { key: "updates", label: "Updates until", value: formatDateIST(new Date(l.updatesUntil)), sub: updatesEnded ? "Ended" : "Included" },
    { key: "limit", label: "Device limit", value: countNoun(l.deviceLimit, l.unit), sub: `${l.devicesUsed} in use` },
    {
      key: "resets",
      label: "Self-service resets",
      value: `${l.selfServiceResetsLeft} of ${l.selfServiceResetsPerYear} left`,
      sub: "Resets yearly",
    },
  ];
}

/** Price unit after an amount: "/year", "/month" or "one-time". */
export function intervalUnit(interval: BillingInterval | null): string {
  return interval === "YEAR" ? "/year" : interval === "MONTH" ? "/month" : "one-time";
}

export type RenewalCardAction = "cart" | "addon" | "choose";

export type RenewalCardCopy = { title: string; body: string; unit: string; cta: string; action: RenewalCardAction };

/** Card copy of one "Renew & upgrade" option (prototype wording). */
export function renewalCardCopy(option: RenewalOption, license: { deviceLimit: number }): RenewalCardCopy {
  const from = option.from ? formatDateIST(new Date(option.from)) : "";
  switch (option.tag) {
    case "BUY":
      return {
        title: "Convert to a paid license",
        body: "Keep the same key and data. Pick a plan to continue.",
        unit: "from,",
        cta: "Choose plan",
        action: "choose",
      };
    case "MAINTENANCE":
      return {
        title: "Renew maintenance",
        body: `Another 12 months of updates and priority support from ${from}.`,
        unit: "/year",
        cta: "Add to cart",
        action: "cart",
      };
    case "RENEWAL":
      return {
        title: `Renew ${option.planName.toLowerCase()}`,
        body: `Extends the term from ${from}. Devices and key stay the same.`,
        unit: intervalUnit(option.interval),
        cta: "Add to cart",
        action: "cart",
      };
    case "ADD-ON":
      return {
        title: "Add computers",
        body: `Raise the device limit from ${license.deviceLimit}. Charged per computer.`,
        unit: "per computer",
        cta: "Choose quantity",
        action: "addon",
      };
    case "UPGRADE":
      return {
        title: "Switch to a one-time license",
        body: "Pay once and stop yearly renewals. Includes 12 months of updates.",
        unit: "one-time",
        cta: "Add to cart",
        action: "cart",
      };
  }
}

const SYSTEM_ACTORS = new Set(["System", "Device", ""]);

/**
 * Activity tab line: bold event, then "· {detail} · {person}" ("You" for the signed-in member). The member's own
 * deactivation reads as in the prototype: "Deactivated by you · Old counter PC".
 */
export function historyLine(
  entry: Pick<LicenseHistoryEntry, "type" | "label" | "actor" | "detail">,
  userName: string,
): { what: string; who: string } {
  const actor = entry.actor.trim();
  if (entry.type === "deactivated" && actor !== "" && actor === userName.trim()) {
    return { what: "Deactivated by you", who: entry.detail ?? "" };
  }
  const parts: string[] = [];
  if (entry.detail) parts.push(entry.detail);
  if (!SYSTEM_ACTORS.has(actor)) parts.push(actor === userName ? "You" : actor);
  return { what: entry.label, who: parts.join(" · ") };
}
