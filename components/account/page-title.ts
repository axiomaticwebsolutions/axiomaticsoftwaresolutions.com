/**
 * The H1 a portal path will show, known before its data loads (the loading and error states use it, so the heading
 * does not change when the page arrives). Pure and client-safe.
 */
import { navKeyForPath, portalSegments, sectionLabel } from "@/components/account/portal-nav";
import { TICKETS_COPY } from "@/components/account/tickets/model";

/**
 * Section pages: their title (the nav label, except "Support tickets" and "New support ticket"). Null for pages titled
 * by their data (a license "Medical Store Billing · LIC-24017", a ticket's subject) and for unknown portal paths.
 */
export function pageTitleForPath(pathname: string | null | undefined): string | null {
  const key = navKeyForPath(pathname);
  if (!key) return null;
  const segments = portalSegments(pathname) ?? [];
  if (key === "tickets") {
    if (segments.length === 1) return TICKETS_COPY.listTitle;
    if (segments.length === 2 && segments[1] === "new") return TICKETS_COPY.newTitle;
    return null;
  }
  return segments.length > 1 ? null : sectionLabel(key);
}
