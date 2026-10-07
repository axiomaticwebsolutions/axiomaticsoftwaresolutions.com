/**
 * GET /api/account/notifications?filter=all|unread&cursor= -> 200 { notifications, unread, nextCursor, prefs }:
 * the signed-in user's in-app notifications, newest first, 30 per page (pass nextCursor for more), the unread count
 * and their email preferences. Any team role, verified email.
 *
 * PATCH /api/account/notifications { renewals?, updates?, tickets?, offers? } -> 200 { prefs }: the "Email
 * preferences" switches (same as PATCH /api/me/preferences). Turning offers on records the consent time. CSRF + same
 * origin. 120 writes / 10 min per user.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { listNotifications } from "@/lib/portal/notifications";
import { getEmailPrefs, updateEmailPrefs } from "@/lib/portal/preferences";
import { emailPrefsPatchSchema, parseNotificationListQuery, PORTAL_BODY_MAX_BYTES } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const ctx = await requireLicenseMember(req);
  const query = parseNotificationListQuery(req.nextUrl.searchParams);
  const list = await listNotifications(db, ctx.user.id, query);
  return json({ ...list, prefs: await getEmailPrefs(ctx.user.id, db) });
});

export const PATCH = route(async (req) => {
  const ctx = await requireLicenseMember(req, { mutation: true });
  const patch = await parseJsonBody(req, emailPrefsPatchSchema, { maxBytes: PORTAL_BODY_MAX_BYTES });
  enforce(await hit(db, RATE_LIMITS.notificationWrites(ctx.user.id)));
  return json({ prefs: await updateEmailPrefs(ctx.user.id, patch, { client: db }) });
});
