/**
 * Pure view model of the portal Notifications page (Customer Portal prototype "Notifications"; decisions.md Phase 5
 * "Notifications"): copy, the All / Unread filter in the URL, local read-state updates, paging merges, where a
 * notification link goes, and the email preference rows with the offers consent note (DPDP). Client-safe; no React.
 */
import { formatDateIST } from "@/lib/dates";
import { EMAIL_PREF_KEYS, EMAIL_PREF_LABELS, type EmailPrefKey } from "@/lib/validation/portal";

export const NOTIFICATIONS_PATH = "/account/notifications";

export const NOTIFICATIONS_COPY = {
  title: "Notifications",
  description: "Renewal reminders, release announcements and ticket updates.",
  markAll: "Mark all read",
  markedAll: "All marked as read",
  all: "All",
  filterLabel: "Show notifications",
  listLabel: "Notifications",
  empty: "You’re all caught up.",
  unreadSuffix: " (unread)",
  showMore: "Show more",
  prefsTitle: "Email preferences",
  prefsNote: "Security alerts and invoices are always sent.",
  offersHint: "Product news and occasional offers. Turning this on records your consent.",
} as const;

export function unreadTabLabel(unread: number): string {
  return `Unread (${unread})`;
}

/** "You agreed to these emails on 7 Oct 2026. You can turn them off at any time." */
export function offersConsentNote(consentAt: string | null): string {
  if (!consentAt) return NOTIFICATIONS_COPY.offersHint;
  const at = new Date(consentAt);
  if (Number.isNaN(at.getTime())) return NOTIFICATIONS_COPY.offersHint;
  return `You agreed to these emails on ${formatDateIST(at)}. You can turn them off at any time.`;
}

export type NotificationFilter = "all" | "unread";

export function parseNotificationFilter(raw: string | null | undefined): NotificationFilter {
  return raw === "unread" ? "unread" : "all";
}

/** The page URL for a filter ("All" is the default and stays out of the URL). */
export function notificationsHref(filter: NotificationFilter): string {
  return filter === "unread" ? `${NOTIFICATIONS_PATH}?filter=unread` : NOTIFICATIONS_PATH;
}

/** The notification fields this page reads (NotificationView from lib/portal/notifications). */
export type NotificationItem = {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
};

/** Marks `ids` (or every item when ids is undefined) read at `readAt`; already-read items keep their time. */
export function markItemsRead<T extends NotificationItem>(items: readonly T[], ids: readonly string[] | undefined, readAt: string): T[] {
  const set = ids ? new Set(ids) : null;
  return items.map((item) => (item.read || (set && !set.has(item.id)) ? item : { ...item, read: true, readAt }));
}

/**
 * Rows to show: the Unread tab drops items read on this page (prototype: the filter applies to the current state),
 * the All tab shows everything.
 */
export function visibleNotifications<T extends NotificationItem>(items: readonly T[], filter: NotificationFilter): T[] {
  return filter === "unread" ? items.filter((item) => !item.read) : [...items];
}

/** Appends a further page, skipping ids already listed. */
export function appendPage<T extends { id: string }>(items: readonly T[], page: readonly T[]): T[] {
  const seen = new Set(items.map((item) => item.id));
  return [...items, ...page.filter((item) => !seen.has(item.id))];
}

/** Portal pages navigate in the app; other paths (order pages with their own CSP) need a full page load. */
export function isPortalHref(href: string): boolean {
  return href === "/account" || href.startsWith("/account/") || href.startsWith("/account?");
}

export type EmailPrefsView = Record<EmailPrefKey, boolean> & { offersConsentAt: string | null };

export type EmailPrefRow = { key: EmailPrefKey; label: string; on: boolean; note: string | null };

/** The four switches in prototype order; offers carries the consent note. */
export function emailPrefRows(prefs: EmailPrefsView): EmailPrefRow[] {
  return EMAIL_PREF_KEYS.map((key) => ({
    key,
    label: EMAIL_PREF_LABELS[key],
    on: prefs[key],
    note: key === "offers" ? offersConsentNote(prefs.offers ? prefs.offersConsentAt : null) : null,
  }));
}
