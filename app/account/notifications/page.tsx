import type { Metadata } from "next";
import { loadNotificationsPage } from "@/components/account/notifications/data";
import { parseNotificationFilter } from "@/components/account/notifications/model";
import { NotificationsView } from "@/components/account/notifications/notifications-view";
import { getPortalContext } from "@/lib/portal/context";
import { readParam } from "@/lib/url-state";

export const metadata: Metadata = { title: "Notifications" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Notifications (prototype "Notifications"; decisions.md Phase 5): the signed-in member's in-app notifications (any
 * team role) with ?filter=unread, and their email preferences.
 */
export default async function NotificationsPage({ searchParams }: Props) {
  const [portal, params] = await Promise.all([getPortalContext(), searchParams]);
  const filter = parseNotificationFilter(readParam(params, "filter"));
  const { list, prefs } = await loadNotificationsPage(portal.user.id, filter);
  return (
    <NotificationsView
      initial={{ notifications: list.notifications, unread: list.unread, nextCursor: list.nextCursor }}
      prefs={{ renewals: prefs.renewals, updates: prefs.updates, tickets: prefs.tickets, offers: prefs.offers, offersConsentAt: prefs.offersConsentAt }}
      filter={filter}
      nowIso={new Date().toISOString()}
    />
  );
}
