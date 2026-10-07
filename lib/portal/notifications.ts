/**
 * In-app notifications of the signed-in user (portal Notifications page and the top-bar bell; decisions.md Phase 5).
 * Notifications belong to a user, not to a business account, so every query is scoped to the session's user id and
 * ids from the client only ever select that user's rows. Newest first, 30 per page with a keyset cursor (the id of the
 * last row seen). Links are kept only when they are same-site relative paths.
 */
import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import type { NotificationListQuery } from "@/lib/validation/portal";

export const NOTIFICATIONS_PAGE_SIZE = 30;

/** Kinds the portal styles (prototype NI map, plus security): renewal | update | ticket | billing | security. */
export const NOTIFICATION_KINDS = ["renewal", "update", "ticket", "billing", "security"] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export type NotificationView = {
  id: string;
  /** One of NOTIFICATION_KINDS; unknown stored kinds read as "update". */
  kind: NotificationKind;
  title: string;
  body: string;
  /** Same-site path ("/account/licenses/LIC-24017"), or null. */
  href: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
};

export type NotificationList = {
  notifications: NotificationView[];
  /** Unread notifications of the user (all pages): "Unread ({n})" and the bell badge. */
  unread: number;
  /** Pass as ?cursor= for the next page; null on the last page. */
  nextCursor: string | null;
};

/** A relative path inside this site: "/..." but not "//host" or "/\host" (which browsers treat as another origin). */
export function safeNotificationHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const value = href.trim();
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  for (const ch of value) {
    const c = ch.codePointAt(0) ?? 0;
    if (c <= 0x20 || c === 0x7f) return null;
  }
  return value.length <= 500 ? value : null;
}

function kindOf(kind: string): NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(kind) ? (kind as NotificationKind) : "update";
}

type NotificationRecord = {
  id: string;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  readAt: Date | null;
  createdAt: Date;
};

export function toNotificationView(n: NotificationRecord): NotificationView {
  return {
    id: n.id,
    kind: kindOf(n.kind),
    title: n.title,
    body: n.body,
    href: safeNotificationHref(n.href),
    read: n.readAt !== null,
    readAt: n.readAt ? n.readAt.toISOString() : null,
    createdAt: n.createdAt.toISOString(),
  };
}

const NOTIFICATION_SELECT = {
  id: true,
  kind: true,
  title: true,
  body: true,
  href: true,
  readAt: true,
  createdAt: true,
} as const satisfies Prisma.NotificationSelect;

export async function unreadCount(client: Db, userId: string): Promise<number> {
  return client.notification.count({ where: { userId, readAt: null } });
}

export async function listNotifications(client: Db, userId: string, query: NotificationListQuery): Promise<NotificationList> {
  const base: Prisma.NotificationWhereInput = { userId, ...(query.filter === "unread" ? { readAt: null } : {}) };
  let where: Prisma.NotificationWhereInput = base;
  if (query.cursor) {
    // The cursor is only honoured when it is one of this user's notifications; otherwise the list starts at the top.
    const after = await client.notification.findFirst({ where: { id: query.cursor, userId }, select: { id: true, createdAt: true } });
    if (after) {
      where = {
        AND: [
          base,
          { OR: [{ createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } }] },
        ],
      };
    }
  }
  const rows = await client.notification.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: NOTIFICATIONS_PAGE_SIZE + 1,
    select: NOTIFICATION_SELECT,
  });
  const page = rows.slice(0, NOTIFICATIONS_PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    notifications: page.map(toNotificationView),
    unread: await unreadCount(client, userId),
    nextCursor: rows.length > NOTIFICATIONS_PAGE_SIZE && last ? last.id : null,
  };
}

/**
 * Marks the user's notifications read: the given ids (other users' ids and unknown ids are ignored), or every unread
 * one when `ids` is omitted ("Mark all read"). Already-read rows keep their first readAt. Returns the new unread count.
 */
export async function markNotificationsRead(
  client: Db,
  userId: string,
  ids: readonly string[] | undefined,
  now: Date,
): Promise<{ updated: number; unread: number }> {
  const { count } = await client.notification.updateMany({
    where: { userId, readAt: null, ...(ids ? { id: { in: [...new Set(ids)] } } : {}) },
    data: { readAt: now },
  });
  return { updated: count, unread: await unreadCount(client, userId) };
}
