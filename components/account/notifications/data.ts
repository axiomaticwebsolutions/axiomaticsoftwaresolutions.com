/**
 * Server loader of the Notifications page: the signed-in user's notifications (newest first, first page, All or
 * Unread) and their email preferences. Notifications belong to the user, never to the URL.
 */
import "server-only";
import { db } from "@/lib/db";
import { listNotifications, type NotificationList } from "@/lib/portal/notifications";
import { getEmailPrefs, type EmailPrefs } from "@/lib/portal/preferences";
import type { NotificationFilter } from "@/components/account/notifications/model";

export async function loadNotificationsPage(userId: string, filter: NotificationFilter): Promise<{ list: NotificationList; prefs: EmailPrefs }> {
  const [list, prefs] = await Promise.all([listNotifications(db, userId, { filter, cursor: null }), getEmailPrefs(userId, db)]);
  return { list, prefs };
}
