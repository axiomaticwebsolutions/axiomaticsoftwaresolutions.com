/**
 * Admin console navigation model (pure, client-safe): module routes, the sidebar groups with locks and badges, the
 * module search, breadcrumbs and page titles. lib/rbac.ts ADMIN_MODULES stays the single source of modules, labels,
 * icons and gates; this file only arranges them for the shell (Admin Console.dc.html sidebar and top bar).
 */
import type { Metadata } from "next";
import type { StaffRole } from "@/generated/prisma/enums";
import { safeNext } from "@/lib/auth/redirect";
import {
  ADMIN_MODULE_GROUPS,
  ADMIN_MODULES,
  adminGroupTitle,
  canViewModule,
  isAdminModuleKey,
  type AdminModule,
  type AdminModuleGroup,
  type AdminModuleKey,
} from "@/lib/rbac";

export const ADMIN_HOME = "/admin";

/** A module as the shell shows it to the signed-in role. */
export type AdminModuleView = Omit<AdminModule, "key"> & {
  key: AdminModuleKey;
  href: string;
  /** The role cannot open it: the sidebar shows a lock and the page renders the permission-denied state. */
  locked: boolean;
  /** Count badge (Orders: pending or in review; Tickets: open and unassigned); 0 = none. */
  badge: number;
};

export type AdminNavGroup = { group: AdminModuleGroup; label: string; items: AdminModuleView[] };

/** Badge counts the layout loads (only for modules the role can open). */
export type AdminBadgeCounts = Partial<Record<AdminModuleKey, number>>;

/** Overview lives at /admin, every other module at /admin/<key>. */
export function moduleHref(key: AdminModuleKey): string {
  return key === "overview" ? ADMIN_HOME : `${ADMIN_HOME}/${key}`;
}

/** The module a pathname belongs to ("/admin/orders/AX-1" -> "orders"), or null outside the known modules. */
export function moduleKeyForPath(pathname: string | null | undefined): AdminModuleKey | null {
  if (!pathname) return null;
  const path = pathname.split(/[?#]/)[0] ?? "";
  if (path === ADMIN_HOME || path === `${ADMIN_HOME}/`) return "overview";
  if (!path.startsWith(`${ADMIN_HOME}/`)) return null;
  const segment = path.slice(ADMIN_HOME.length + 1).split("/")[0] ?? "";
  if (segment === "overview") return null; // the overview has no /admin/overview route
  return isAdminModuleKey(segment) ? segment : null;
}

function isAdminPath(path: string): boolean {
  return path === ADMIN_HOME || path.startsWith(`${ADMIN_HOME}/`) || path.startsWith(`${ADMIN_HOME}?`);
}

/** The requested admin path from the middleware header (x-axs-path), validated; /admin when missing or unusable. */
export function adminPathFrom(raw: string | null | undefined): string {
  const safe = safeNext(raw);
  return safe && isAdminPath(safe) ? safe : ADMIN_HOME;
}

/** Every module for this role, in sidebar order, with its lock and badge. */
export function moduleViewsFor(role: StaffRole, badges: AdminBadgeCounts = {}): AdminModuleView[] {
  return ADMIN_MODULES.map((m) => {
    const key = m.key as AdminModuleKey;
    const locked = !canViewModule(role, key);
    const count = badges[key] ?? 0;
    return { ...m, key, href: moduleHref(key), locked, badge: locked || !Number.isFinite(count) || count < 0 ? 0 : Math.floor(count) };
  });
}

/** Sidebar groups (DASHBOARD, CATALOG, SALES, ...) in rbac order; empty groups are left out. */
export function adminNavGroups(modules: readonly AdminModuleView[]): AdminNavGroup[] {
  return ADMIN_MODULE_GROUPS.map((group) => ({ group, label: group, items: modules.filter((m) => m.group === group) })).filter(
    (g) => g.items.length > 0,
  );
}

/** Visually hidden text after a nav badge ("Orders & payments, 3 pending or in review"). */
export function badgeLabel(key: AdminModuleKey, count: number): string {
  if (key === "orders") return `${count} pending or in review`;
  if (key === "tickets") return `${count} open and unassigned`;
  return `${count} new`;
}

/** Sidebar badge text: counts above 99 read "99+". */
export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** Breadcrumb trail of a module page: "Admin / Sales / Orders, payments & refunds". */
export function adminBreadcrumb(mod: Pick<AdminModule, "group" | "title">): [string, string, string] {
  return ["Admin", adminGroupTitle(mod.group), mod.title];
}

/** Two initials for the avatar ("Vikram Rao" -> "VR"; one word -> its first two letters). */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return (words[0] ?? "").slice(0, 2).toUpperCase();
  return `${(words[0] ?? "").charAt(0)}${(words[words.length - 1] ?? "").charAt(0)}`.toUpperCase();
}

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Top-bar module search: modules whose name (label, title, key or group) contains every typed word, best first
 * (label starts with the query, then a label word does, then the title, then the rest). Only when no name matches
 * are descriptions searched ("refund" finds Orders). An empty query lists every module in sidebar order. Locked
 * modules stay in the results (they open the permission-denied page).
 */
export function searchModules<M extends Pick<AdminModuleView, "key" | "label" | "title" | "group" | "description">>(
  modules: readonly M[],
  query: string,
): M[] {
  const q = normalize(query);
  if (!q) return [...modules];
  const words = q.split(" ");
  const first = words[0] ?? "";
  const rank = (m: M): number => {
    const label = normalize(m.label);
    if (label.startsWith(q)) return 0;
    if (label.split(" ").some((w) => w.startsWith(first))) return 1;
    if (normalize(m.title).includes(q)) return 2;
    return 3;
  };
  const matching = (text: (m: M) => string) =>
    modules
      .map((m, index) => ({ m, index }))
      .filter(({ m }) => {
        const haystack = text(m);
        return words.every((w) => haystack.includes(w));
      })
      .map(({ m, index }) => ({ m, index, score: rank(m) }))
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .map((hit) => hit.m);
  const byName = matching((m) => `${normalize(m.label)} ${normalize(m.title)} ${normalize(m.key)} ${normalize(m.group)}`);
  return byName.length > 0 ? byName : matching((m) => normalize(m.description));
}

export const ADMIN_TITLE_SUFFIX = "Admin \u2014 Axiomatic Software Solutions";

/**
 * "{title} · Admin — Axiomatic Software Solutions" as an absolute title. app/admin/layout.tsx's title template applies
 * only to child segments, so pages in the layout's own segment (/admin overview, not-found) would otherwise get the
 * root template ("Overview — Axiomatic Software Solutions").
 */
export function adminTitle(title: string): { absolute: string } {
  return { absolute: `${title} \u00b7 ${ADMIN_TITLE_SUFFIX}` };
}

/** Metadata for a module page: "Orders, payments & refunds · Admin — Axiomatic Software Solutions", noindex. */
export function adminPageMetadata(key: AdminModuleKey, title?: string): Metadata {
  const mod = ADMIN_MODULES.find((m) => m.key === key);
  return { title: adminTitle(title ?? mod?.title ?? "Admin"), robots: { index: false, follow: false } };
}
