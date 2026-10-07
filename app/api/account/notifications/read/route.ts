/**
 * POST /api/account/notifications/read { ids? } -> 200 { updated, unread }: marks the signed-in user's notifications
 * read; without ids (or with no body) every unread one ("Mark all read"). Ids of other users' notifications are
 * ignored. Any team role, verified email, CSRF + same origin. At most 100 ids; 120 writes / 10 min per user.
 */
import type { NextRequest } from "next/server";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { markNotificationsRead } from "@/lib/portal/notifications";
import { markReadSchema, PORTAL_BODY_MAX_BYTES, type MarkReadInput } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readBody(req: NextRequest): Promise<MarkReadInput> {
  if (req.body === null || req.headers.get("content-length") === "0") return {};
  return parseJsonBody(req, markReadSchema, { maxBytes: PORTAL_BODY_MAX_BYTES });
}

export const POST = route(async (req) => {
  const ctx = await requireLicenseMember(req, { mutation: true });
  const { ids } = await readBody(req);
  enforce(await hit(db, RATE_LIMITS.notificationWrites(ctx.user.id)));
  return json(await markNotificationsRead(db, ctx.user.id, ids, new Date()));
});
