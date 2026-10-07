/**
 * Who may list and download software (decisions.md Phase 4, api-contracts section 5). Server-only.
 * - Account endpoints: a signed-in customer (401), ACTIVE member of their active business account (403
 *   `no_account`) with a verified email (403 `email_unverified`) and, for downloads, the team permission
 *   `downloads` (Owner, Technical; else 403 `forbidden`).
 * - Order endpoint: order access from lib/orders/access (link token or session); a member who reaches the order
 *   through the session only (no link token) also needs `downloads`, so a Viewer cannot download via the order page.
 */
import "server-only";
import { requireAccountRole, TEAM_FORBIDDEN_MESSAGE, type AccountContext } from "@/lib/auth/guards";
import { getSetting, downloadTtlSeconds } from "@/lib/config";
import type { Db } from "@/lib/db";
import { ApiError, errors } from "@/lib/http";
import type { OrderAccess } from "@/lib/orders/access";
import { teamCan, type TeamPermission } from "@/lib/rbac";
import { guestDownloadUserId } from "./issue";

export const DOWNLOAD_EMAIL_UNVERIFIED_MESSAGE = "Verify your email to download software.";
/** Activity actor for downloads through an order link by someone who is not signed in. */
export const ORDER_LINK_ACTOR = "Guest (order link)";

/** The active account of a verified customer, optionally requiring a team permission (401 / 403). */
export async function requireVerifiedAccount(teamPerm?: TeamPermission): Promise<AccountContext> {
  const ctx = await requireAccountRole();
  if (!ctx.user.emailVerifiedAt) throw new ApiError(403, "email_unverified", DOWNLOAD_EMAIL_UNVERIFIED_MESSAGE);
  if (teamPerm && !teamCan(ctx.membership.role, teamPerm)) throw errors.forbidden(TEAM_FORBIDDEN_MESSAGE);
  return ctx;
}

/** Whether this order viewer may download the order's software (see the module comment). */
export function canDownloadFromOrder(access: OrderAccess): boolean {
  if (access.viaToken) return true;
  const { order, viewer } = access;
  const ownAccountlessOrder = order.accountId === null && order.placedByUserId !== null && order.placedByUserId === viewer.userId;
  return ownAccountlessOrder || teamCan(viewer.role, "downloads");
}

export function assertCanDownloadFromOrder(access: OrderAccess): void {
  if (!canDownloadFromOrder(access)) throw errors.forbidden(TEAM_FORBIDDEN_MESSAGE);
}

/** DownloadEvent.userId and activity actor for an order download: the signed-in user, else the order link guest. */
export function orderDownloadActor(access: OrderAccess): { eventUserId: string; actorName: string } {
  const { userId, name } = access.viewer;
  if (userId) return { eventUserId: userId, actorName: name ?? ORDER_LINK_ACTOR };
  return { eventUserId: guestDownloadUserId(access.order.id), actorName: ORDER_LINK_ACTOR };
}

/** Current link lifetime in seconds: min(setting, DOWNLOAD_LINK_TTL_SECONDS, 600). */
export async function currentDownloadTtl(db: Db): Promise<number> {
  const licensing = await getSetting(db, "licensing");
  return downloadTtlSeconds({ licensing });
}
