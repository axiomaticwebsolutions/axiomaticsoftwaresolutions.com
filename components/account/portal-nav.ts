/**
 * Customer portal navigation model (Customer Portal prototype shell): sidebar groups and items in prototype order, the
 * item a pathname belongs to, breadcrumbs, badge counts, team-role gating and its copy, and the shapes the top bar's
 * search and notification menus read. Pure and client-safe (sidebar, drawer, page header, search, tests).
 */
import type { IconSourceName } from "@/components/icons/icon-names";
import type { TeamRole } from "@/generated/prisma/enums";
import { formatDateIST } from "@/lib/dates";
import type { Tone } from "@/lib/design/tokens";
import { formatINR } from "@/lib/money";
import { TEAM_ROLE_META, teamCan, teamRolesFor, type TeamPermission } from "@/lib/rbac";

export const PORTAL_BASE = "/account";

export const PORTAL_PATHS = {
  overview: "/account",
  software: "/account/software",
  licenses: "/account/licenses",
  devices: "/account/devices",
  orders: "/account/orders",
  billing: "/account/billing",
  tickets: "/account/tickets",
  newTicket: "/account/tickets/new",
  notifications: "/account/notifications",
  team: "/account/team",
  activity: "/account/activity",
  security: "/account/security",
  /** Storefront pages the shell links to. */
  store: "/",
  catalog: "/software",
  helpCenter: "/support",
  installGuide: "/docs/install",
  signIn: "/sign-in",
} as const;

export function licensePath(id: string): string {
  return `${PORTAL_PATHS.licenses}/${encodeURIComponent(id)}`;
}

export function ticketPath(id: string): string {
  return `${PORTAL_PATHS.tickets}/${encodeURIComponent(id)}`;
}

/** Order pages are storefront pages with their own CSP (decisions.md Phase 3): link to them with a plain <a>. */
export function orderPath(id: string): string {
  return `/orders/${encodeURIComponent(id)}`;
}

export type PortalNavKey =
  | "overview"
  | "software"
  | "licenses"
  | "devices"
  | "orders"
  | "billing"
  | "tickets"
  | "notifications"
  | "team"
  | "activity"
  | "security";

/** Shell badge counts (lib/portal/context.ts). */
export type PortalCounts = { tickets: number; notifications: number; licensesNeedingAttention: number };

export type PortalBadgeTone = "warn" | "primary";

export type PortalNavItemDef = {
  key: PortalNavKey;
  label: string;
  href: string;
  icon: IconSourceName;
  /** Team permission needed to see the item; items without one are shown to every role. */
  viewPerm?: TeamPermission;
  badge?: { count: keyof PortalCounts; tone: PortalBadgeTone };
};

export type PortalNavGroupDef = { label: string; items: readonly PortalNavItemDef[] };

/**
 * Sidebar groups in prototype order. Labels are sentence case and shown uppercase with CSS (screen readers read
 * "Workspace", not W-O-R-K-...). Team and Activity log are owner-only pages (decisions.md Phase 5 "Access").
 */
export const PORTAL_NAV_GROUPS: readonly PortalNavGroupDef[] = [
  {
    label: "Workspace",
    items: [
      { key: "overview", label: "Overview", href: PORTAL_PATHS.overview, icon: "space_dashboard" },
      { key: "software", label: "Software & downloads", href: PORTAL_PATHS.software, icon: "download", viewPerm: "licenses.view" },
    ],
  },
  {
    label: "Licensing",
    items: [
      {
        key: "licenses",
        label: "Licenses",
        href: PORTAL_PATHS.licenses,
        icon: "key",
        viewPerm: "licenses.view",
        badge: { count: "licensesNeedingAttention", tone: "warn" },
      },
      { key: "devices", label: "Devices", href: PORTAL_PATHS.devices, icon: "devices", viewPerm: "licenses.view" },
    ],
  },
  {
    label: "Billing",
    items: [
      { key: "orders", label: "Orders & invoices", href: PORTAL_PATHS.orders, icon: "receipt_long", viewPerm: "invoices.view" },
      { key: "billing", label: "Billing & tax details", href: PORTAL_PATHS.billing, icon: "account_balance", viewPerm: "invoices.view" },
    ],
  },
  {
    label: "Support",
    items: [
      {
        key: "tickets",
        label: "Tickets",
        href: PORTAL_PATHS.tickets,
        icon: "support_agent",
        viewPerm: "tickets.view",
        badge: { count: "tickets", tone: "primary" },
      },
      {
        key: "notifications",
        label: "Notifications",
        href: PORTAL_PATHS.notifications,
        icon: "notifications",
        badge: { count: "notifications", tone: "primary" },
      },
    ],
  },
  {
    label: "Administration",
    items: [
      { key: "team", label: "Team & access", href: PORTAL_PATHS.team, icon: "group", viewPerm: "team.manage" },
      { key: "activity", label: "Activity log", href: PORTAL_PATHS.activity, icon: "history", viewPerm: "activity.view" },
      { key: "security", label: "Security", href: PORTAL_PATHS.security, icon: "shield_person" },
    ],
  },
];

const ITEMS_BY_KEY = new Map<PortalNavKey, PortalNavItemDef>(
  PORTAL_NAV_GROUPS.flatMap((g) => g.items.map((item) => [item.key, item] as const)),
);

export const PORTAL_NAV_KEYS = [...ITEMS_BY_KEY.keys()];

export function isPortalNavKey(value: string): value is PortalNavKey {
  return ITEMS_BY_KEY.has(value as PortalNavKey);
}

/** Sidebar label of a section, also its breadcrumb and loading title (prototype `names`). */
export function sectionLabel(key: PortalNavKey): string {
  return ITEMS_BY_KEY.get(key)?.label ?? "Overview";
}

export function sectionHref(key: PortalNavKey): string {
  return ITEMS_BY_KEY.get(key)?.href ?? PORTAL_PATHS.overview;
}

/** Path segments below /account ("/account/licenses/LIC-1?x" -> ["licenses", "LIC-1"]), or null outside the portal. */
export function portalSegments(pathname: string | null | undefined): string[] | null {
  const path = (pathname ?? "").split(/[?#]/, 1)[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "account") return null;
  return parts.slice(1);
}

/**
 * The sidebar item a pathname belongs to: /account -> overview, /account/licenses/LIC-1 -> licenses,
 * /account/tickets/new -> tickets (prototype `parentOf`). Unknown portal paths and other areas -> null.
 */
export function navKeyForPath(pathname: string | null | undefined): PortalNavKey | null {
  const segments = portalSegments(pathname);
  if (!segments) return null;
  const first = segments[0];
  if (first === undefined) return "overview";
  return isPortalNavKey(first) && first !== "overview" ? first : null;
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export type Crumb = { label: string; href: string };

/**
 * Breadcrumb trail of a portal page (prototype `crumbs`): business / section / id, plus "New ticket"
 * ("Sharma Medicals / Licenses / LIC-24017"). The last crumb is the current page.
 */
export function breadcrumbTrail(pathname: string | null | undefined, businessName: string): Crumb[] {
  const trail: Crumb[] = [{ label: businessName || "Account", href: PORTAL_PATHS.overview }];
  const key = navKeyForPath(pathname);
  if (!key || key === "overview") return trail;
  trail.push({ label: sectionLabel(key), href: sectionHref(key) });
  const id = portalSegments(pathname)?.[1];
  if (id === undefined) return trail;
  if (key === "tickets" && id === "new") {
    trail.push({ label: "New ticket", href: PORTAL_PATHS.newTicket });
    return trail;
  }
  trail.push({ label: safeDecode(id), href: `${sectionHref(key)}/${id}` });
  return trail;
}

export type PortalNavItem = {
  key: PortalNavKey;
  label: string;
  href: string;
  icon: IconSourceName;
  /** Shown only when above zero; `label` is the screen-reader wording ("2 need attention"). */
  badge: { value: number; tone: PortalBadgeTone; label: string } | null;
};

export type PortalNavGroup = { label: string; items: PortalNavItem[] };

/** What a badge number means, for screen readers (the badge itself is just the number). */
export function badgeLabel(count: keyof PortalCounts, value: number): string {
  if (count === "licensesNeedingAttention") return `${value} ${value === 1 ? "needs" : "need"} attention`;
  return `${value} ${count === "tickets" ? "open" : "unread"}`;
}

/** Sidebar groups for a team role: items the role cannot open are left out (owner-only Team and Activity log). */
export function navGroupsFor(role: TeamRole, counts: PortalCounts): PortalNavGroup[] {
  return PORTAL_NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items
      .filter((item) => !item.viewPerm || teamCan(role, item.viewPerm))
      .map((item) => {
        const value = item.badge ? Math.max(0, Math.trunc(counts[item.badge.count] || 0)) : 0;
        return {
          key: item.key,
          label: item.label,
          href: item.href,
          icon: item.icon,
          badge: item.badge && value > 0 ? { value, tone: item.badge.tone, label: badgeLabel(item.badge.count, value) } : null,
        };
      }),
  })).filter((group) => group.items.length > 0);
}

/** "Owner", "Owner or Technical contact", "Owner, Billing admin or Technical contact". */
export function joinWithOr(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

function roleLabelsFor(perm: TeamPermission): string[] {
  return teamRolesFor(perm).map((role) => TEAM_ROLE_META[role].label);
}

/** Tooltip on an action the role lacks (decisions.md Phase 5): "Requires Owner or Technical contact". */
export function teamRequiresLabel(perm: TeamPermission): string {
  return `Requires ${joinWithOr(roleLabelsFor(perm))}`;
}

/** Permission-denied copy for a page the role cannot open (the admin console's wording, with team roles). */
export function teamAreaDeniedMessage(perm: TeamPermission, role: TeamRole): string {
  return `This area needs ${joinWithOr(roleLabelsFor(perm))} access. You\u2019re signed in as ${TEAM_ROLE_META[role].label}. Ask the account owner if you need it.`;
}

/** "SM" from "Sharma Medicals", "PS" from "Priya Sharma" (first letters of the first two words), "?" when empty. */
export function initialsOf(name: string): string {
  const letters = name
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word)[0] ?? "")
    .join("");
  return Array.from(letters).slice(0, 2).join("").toUpperCase() || "?";
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Business switcher subtitle: "Business · 2 locations" ("1 location", grammar fix of the prototype). */
export function locationsSummary(count: number): string {
  return `Business \u00b7 ${plural(count, "location", "locations")}`;
}

/** "2 devices" / "1 device" (the prototype printed "1 devices"). */
export function devicesLabel(count: number): string {
  return plural(count, "device", "devices");
}

/** Bell label: "Notifications, 2 unread". */
export function notificationsLabel(unread: number): string {
  return `Notifications, ${unread} unread`;
}

/**
 * Relative time from the prototype's rel(): "just now", "3h ago", "yesterday", "12d ago" (under 45 days), else the
 * IST date ("17 Nov 2026").
 */
export function relativeTime(at: Date, now: Date = new Date()): string {
  const diff = now.getTime() - at.getTime();
  const days = Math.round(diff / 86_400_000);
  if (days <= 0) {
    const hours = Math.round(diff / 3_600_000);
    return hours <= 0 ? "just now" : `${hours}h ago`;
  }
  if (days === 1) return "yesterday";
  return days < 45 ? `${days}d ago` : formatDateIST(at);
}

// ---------- Global search (GET /api/account/search?q=) ----------

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_MAX_RESULTS = 20;

export type PortalSearchKind = "license" | "device" | "order" | "ticket";

/** Result groups in prototype order, with the row's type label and icon tile. */
export const SEARCH_GROUPS: readonly { kind: PortalSearchKind; heading: string; type: string; icon: IconSourceName }[] = [
  { kind: "license", heading: "Licenses", type: "LICENSE", icon: "key" },
  { kind: "device", heading: "Devices", type: "DEVICE", icon: "computer" },
  { kind: "order", heading: "Orders", type: "ORDER", icon: "receipt_long" },
  { kind: "ticket", heading: "Tickets", type: "TICKET", icon: "support_agent" },
];

export type PortalSearchResult = {
  kind: PortalSearchKind;
  id: string;
  title: string;
  subtitle: string;
  href: string;
  /** Pages outside the portal (order pages carry their own CSP) open with a full page load. */
  fullPageLoad: boolean;
};

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nested(value: unknown, key: string): unknown {
  return rec(value)?.[key];
}

/** A same-origin path from the API ("/account/..."), never an absolute or protocol-relative URL. */
export function safeInternalHref(value: unknown): string | null {
  const href = str(value);
  if (!href || !href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return null;
  return href;
}

function joinDot(parts: readonly (string | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(" \u00b7 ");
}

const KIND_ALIASES: Record<string, PortalSearchKind> = {
  license: "license",
  licenses: "license",
  device: "device",
  devices: "device",
  order: "order",
  orders: "order",
  ticket: "ticket",
  tickets: "ticket",
};

function kindOf(value: unknown): PortalSearchKind | null {
  const key = str(value)?.toLowerCase();
  return key ? (KIND_ALIASES[key] ?? null) : null;
}

function licenseResult(r: Rec): PortalSearchResult | null {
  const id = str(r.id) ?? str(r.licenseId);
  if (!id) return null;
  const product = r.product;
  const short =
    str(r.productShortName) ?? str(r.productShort) ?? str(nested(product, "shortName")) ?? str(r.productName) ??
    str(nested(product, "name")) ?? str(product);
  const plan = str(r.planName) ?? str(nested(r.plan, "name")) ?? str(r.plan);
  const last4 = str(r.keyLast4) ?? str(r.last4);
  const code = str(r.productCode) ?? str(nested(product, "code"));
  const masked =
    str(r.keyMasked) ?? str(r.maskedKey) ?? (last4 ? `${code ? `${code}-` : ""}\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-\u2022\u2022\u2022\u2022-${last4}` : null);
  const href = safeInternalHref(r.href) ?? licensePath(id);
  return {
    kind: "license",
    id,
    title: str(r.title) ?? joinDot([id, short]),
    subtitle: str(r.subtitle) ?? str(r.sub) ?? joinDot([plan, masked]),
    href,
    fullPageLoad: !href.startsWith(PORTAL_BASE),
  };
}

function deviceResult(r: Rec): PortalSearchResult | null {
  const id = str(r.id) ?? str(r.deviceId);
  const name = str(r.name) ?? str(r.title);
  if (!id && !name) return null;
  const licenseId = str(r.licenseId) ?? str(nested(r.license, "id"));
  const inactive = r.active === false || Boolean(r.deactivatedAt) || str(r.status)?.toLowerCase() === "deactivated";
  const href = safeInternalHref(r.href) ?? (licenseId ? `${licensePath(licenseId)}?tab=devices` : PORTAL_PATHS.devices);
  const sub = joinDot([licenseId, str(r.os)]);
  return {
    kind: "device",
    id: id ?? name ?? "",
    title: str(r.title) ?? name ?? id ?? "",
    subtitle: str(r.subtitle) ?? str(r.sub) ?? (inactive ? joinDot([sub, "deactivated"]) : sub),
    href,
    fullPageLoad: !href.startsWith(PORTAL_BASE),
  };
}

function orderResult(r: Rec): PortalSearchResult | null {
  const id = str(r.id) ?? str(r.orderId);
  if (!id) return null;
  const invoice = str(r.invoiceNumber) ?? str(r.invoiceNo) ?? str(nested(r.invoice, "number"));
  const paise = num(r.totalPaise) ?? num(r.grandTotalPaise);
  const total = paise !== null && Number.isSafeInteger(paise) ? formatINR(paise) : (str(r.totalLabel) ?? str(r.total));
  const href = safeInternalHref(r.href) ?? orderPath(id);
  return {
    kind: "order",
    id,
    title: str(r.title) ?? id,
    subtitle: str(r.subtitle) ?? str(r.sub) ?? joinDot([invoice ?? "No invoice", total]),
    href,
    fullPageLoad: !href.startsWith(PORTAL_BASE),
  };
}

function ticketResult(r: Rec): PortalSearchResult | null {
  const id = str(r.id) ?? str(r.ticketId);
  if (!id) return null;
  const href = safeInternalHref(r.href) ?? ticketPath(id);
  return {
    kind: "ticket",
    id,
    title: str(r.title) ?? id,
    subtitle: str(r.subtitle) ?? str(r.sub) ?? str(r.subject) ?? "",
    href,
    fullPageLoad: !href.startsWith(PORTAL_BASE),
  };
}

const BUILDERS: Record<PortalSearchKind, (r: Rec) => PortalSearchResult | null> = {
  license: licenseResult,
  device: deviceResult,
  order: orderResult,
  ticket: ticketResult,
};

/**
 * Normalises the search response into rows in group order (licenses, devices, orders, tickets), at most 20.
 * Accepts the flat form `{ results: [{ type, id, title, subtitle, href }] }` and the grouped form
 * `{ licenses: [...], devices: [...], orders: [...], tickets: [...] }` (optionally under `groups`/`results`), building
 * titles and links the way the prototype does when the API leaves them out. Unknown rows are skipped.
 */
export function normalizeSearchResponse(body: unknown): PortalSearchResult[] {
  const root = rec(body);
  if (!root) return [];
  const byKind: Record<PortalSearchKind, PortalSearchResult[]> = { license: [], device: [], order: [], ticket: [] };
  const push = (kind: PortalSearchKind, row: unknown) => {
    const r = rec(row);
    const result = r ? BUILDERS[kind](r) : null;
    if (result) byKind[kind].push(result);
  };
  const flat = Array.isArray(root.results) ? root.results : Array.isArray(root.items) ? root.items : null;
  if (flat) {
    for (const row of flat) {
      const kind = kindOf(nested(row, "type")) ?? kindOf(nested(row, "kind"));
      if (kind) push(kind, row);
    }
  } else {
    const groups = rec(root.groups) ?? rec(root.results) ?? root;
    for (const [key, rows] of Object.entries(groups)) {
      const kind = kindOf(key);
      if (kind && Array.isArray(rows)) for (const row of rows) push(kind, row);
    }
  }
  return SEARCH_GROUPS.flatMap((g) => byKind[g.kind]).slice(0, SEARCH_MAX_RESULTS);
}

// ---------- Notification menu (GET /api/account/notifications) ----------

export type PortalNotification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  read: boolean;
  createdAt: Date | null;
};

/** Prototype NI map, plus `security` (the prototype had no icon for it). */
const NOTIFICATION_VISUALS: Record<string, { icon: IconSourceName; tone: Tone }> = {
  ticket: { icon: "support_agent", tone: "blue" },
  renewal: { icon: "event_upcoming", tone: "peach" },
  update: { icon: "new_releases", tone: "sage" },
  billing: { icon: "receipt_long", tone: "lavender" },
  security: { icon: "shield", tone: "pink" },
};

export function notificationVisual(kind: string): { icon: IconSourceName; tone: Tone } {
  return NOTIFICATION_VISUALS[kind] ?? { icon: "notifications", tone: "lavender" };
}

function dateOf(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Notification rows and the unread count (when the API sends one) from `{ notifications | items: [...] }`. */
export function normalizeNotifications(body: unknown): { items: PortalNotification[]; unread: number | null } {
  const root = rec(body);
  const list = Array.isArray(body) ? body : Array.isArray(root?.notifications) ? root.notifications : Array.isArray(root?.items) ? root.items : [];
  const items: PortalNotification[] = [];
  for (const row of list) {
    const r = rec(row);
    const id = r ? str(r.id) : null;
    if (!r || !id) continue;
    items.push({
      id,
      kind: str(r.kind)?.toLowerCase() ?? "",
      title: str(r.title) ?? "",
      body: str(r.body) ?? "",
      href: safeInternalHref(r.href),
      read: r.read === true || Boolean(r.readAt),
      createdAt: dateOf(r.createdAt ?? r.at),
    });
  }
  const unread = num(root?.unread) ?? num(root?.unreadCount) ?? num(nested(root?.counts, "unread"));
  return { items, unread };
}
