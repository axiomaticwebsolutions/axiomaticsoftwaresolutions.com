/**
 * Pure helpers of the admin UI components (client- and server-safe, unit-tested): status labels and tones, the
 * drawer facts grid layout and drawer URL parameters.
 */
import { LICENSE_STATUS_META } from "@/lib/licensing/status";

/** Badge tones of the admin prototype (README colour table; every pair meets 4.5:1). */
export type StatusTone = "sage" | "peach" | "pink" | "lavender" | "blue" | "slate";

export type StatusMeta = { label: string; tone: StatusTone };

type StatusMap = Readonly<Record<string, StatusMeta>>;

const licenseMap: StatusMap = Object.fromEntries(
  Object.entries(LICENSE_STATUS_META).map(([status, meta]) => [status, { label: meta.adminLabel, tone: meta.tone }]),
);

/**
 * Status labels and tones per domain, from the Admin Console prototype (OS, LS, TS maps and the module badges). Keys
 * are lower case; Prisma enum values (PAID, AWAITING_CUSTOMER) and derived statuses (expiring) both match.
 * New statuses the prototype lacks: Partly refunded, Closed (tickets), Withdrawn (releases), refund, payment and
 * lead states.
 */
export const STATUS_META = {
  order: {
    awaiting_payment: { label: "Awaiting payment", tone: "slate" },
    confirming: { label: "Confirming", tone: "blue" },
    pending: { label: "Pending", tone: "peach" },
    paid: { label: "Paid", tone: "sage" },
    failed: { label: "Failed", tone: "pink" },
    canceled: { label: "Canceled", tone: "slate" },
    refunded: { label: "Refunded", tone: "lavender" },
    partially_refunded: { label: "Partly refunded", tone: "lavender" },
    review: { label: "In review", tone: "peach" },
  },
  payment: {
    created: { label: "Created", tone: "slate" },
    authorized: { label: "Authorized", tone: "blue" },
    pending: { label: "Pending", tone: "peach" },
    captured: { label: "Captured", tone: "sage" },
    failed: { label: "Failed", tone: "pink" },
    canceled: { label: "Canceled", tone: "slate" },
    refunded: { label: "Refunded", tone: "lavender" },
  },
  refund: {
    pending: { label: "Pending", tone: "peach" },
    processed: { label: "Processed", tone: "sage" },
    failed: { label: "Failed", tone: "pink" },
  },
  /** Derived license status (lib/licensing/status.ts deriveLicenseStatus), admin labels ("Expiring"). */
  license: licenseMap,
  ticket: {
    open: { label: "Open", tone: "blue" },
    awaiting_customer: { label: "Awaiting customer", tone: "peach" },
    resolved: { label: "Resolved", tone: "sage" },
    closed: { label: "Closed", tone: "slate" },
  },
  priority: {
    low: { label: "Low", tone: "slate" },
    normal: { label: "Normal", tone: "blue" },
    high: { label: "High", tone: "pink" },
  },
  /** Derived coupon status: paused (inactive), scheduled (starts later), expired (ended or used up), else active. */
  coupon: {
    active: { label: "Active", tone: "sage" },
    scheduled: { label: "Scheduled", tone: "blue" },
    paused: { label: "Paused", tone: "peach" },
    expired: { label: "Expired", tone: "slate" },
  },
  staff: {
    active: { label: "Active", tone: "sage" },
    invited: { label: "Invited", tone: "peach" },
    deactivated: { label: "Deactivated", tone: "slate" },
  },
  role: {
    owner: { label: "Owner", tone: "lavender" },
    admin: { label: "Administrator", tone: "blue" },
    support: { label: "Support", tone: "sage" },
    finance: { label: "Finance", tone: "peach" },
  },
  product: {
    published: { label: "Published", tone: "sage" },
    coming_soon: { label: "Coming soon", tone: "lavender" },
    hidden: { label: "Hidden", tone: "slate" },
    draft: { label: "Draft", tone: "peach" },
  },
  plan: {
    active: { label: "On sale", tone: "sage" },
    archived: { label: "Archived", tone: "slate" },
  },
  /** Release status plus the derived "latest" (newest published release of a product). */
  release: {
    latest: { label: "Latest", tone: "sage" },
    published: { label: "Published", tone: "blue" },
    draft: { label: "Draft", tone: "peach" },
    withdrawn: { label: "Withdrawn", tone: "slate" },
  },
  template: {
    active: { label: "Active", tone: "sage" },
    draft: { label: "Draft", tone: "peach" },
  },
  faq: {
    published: { label: "Published", tone: "sage" },
    draft: { label: "Draft", tone: "peach" },
  },
  lead: {
    new: { label: "New", tone: "blue" },
    contacted: { label: "Contacted", tone: "lavender" },
    scheduled: { label: "Scheduled", tone: "peach" },
    closed: { label: "Closed", tone: "sage" },
    spam: { label: "Spam", tone: "slate" },
  },
} as const satisfies Record<string, StatusMap>;

export type StatusKind = keyof typeof STATUS_META;

/** "AWAITING_CUSTOMER" -> "Awaiting customer" (fallback label for a status no map knows). */
export function humanizeStatus(status: string): string {
  const words = status.trim().replace(/[_-]+/g, " ").toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "\u2014";
}

/** Label and tone of a status (unknown statuses read as their humanized value in slate). */
export function statusMeta(kind: StatusKind, status: string | null | undefined): StatusMeta {
  const key = (status ?? "").trim().toLowerCase();
  const map: StatusMap = STATUS_META[kind];
  return map[key] ?? { label: humanizeStatus(key), tone: "slate" };
}

/** Grid position of each cell: right column (no right border) and last row (no bottom border). */
export function fieldGridLayout(fields: readonly { wide?: boolean }[]): { right: boolean; lastRow: boolean }[] {
  let col = 0;
  let row = 0;
  const placed = fields.map((field) => {
    if (field.wide) {
      if (col === 1) row += 1;
      const cell = { row, right: true };
      row += 1;
      col = 0;
      return cell;
    }
    const cell = { row, right: col === 1 };
    if (col === 1) row += 1;
    col = col === 1 ? 0 : 1;
    return cell;
  });
  const last = placed.reduce((max, cell) => Math.max(max, cell.row), 0);
  return placed.map((cell) => ({ right: cell.right, lastRow: cell.row === last }));
}

/** `search` with `param` set to `value` (or removed when null), as "?a=1&b=2" or "". */
export function withParam(search: string, param: string, value: string | null): string {
  const params = new URLSearchParams(search);
  if (value === null) params.delete(param);
  else params.set(param, value);
  const text = params.toString();
  return text ? `?${text}` : "";
}
