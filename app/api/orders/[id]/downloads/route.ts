/**
 * POST /api/orders/:id/downloads { releaseFileId, t? } (decisions.md 10 and Phase 4): downloads from the order page.
 * Access as for the order page (lib/orders/access): the order link token `t` (body, else `?t=`), or the session
 * (member of the order's account, or the placer of an account-less order). 401 signed out without a token,
 * 403 `order_link_expired`, 404 for unknown orders and bad or foreign tokens (ids cannot be probed). A member who
 * reaches the order only through the session also needs the team permission `downloads`.
 * Only licenses this order issued can entitle the download (same checks as /api/account/downloads; 403
 * `not_entitled` with `reason`). DownloadEvent.userId is the signed-in user, else "guest:<orderId>".
 * CSRF + same origin ("anon" binding for guests). Limits: 30 order actions / 10 min per IP, counted before the
 * token is checked, then 30 links / hour per downloader. 200 as /api/account/downloads. Cache-Control: no-store.
 */
import { z } from "zod";
import { getCurrentAuth } from "@/lib/auth/guards";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { assertCheckoutCsrf, orderTokenFrom } from "@/lib/checkout/request";
import { db } from "@/lib/db";
import { assertCanDownloadFromOrder, currentDownloadTtl, orderDownloadActor } from "@/lib/downloads/access";
import { issueDownload } from "@/lib/downloads/issue";
import { RELEASE_FILE_ID_RE } from "@/lib/downloads/model";
import { clientIp, json, parseJsonBody, route } from "@/lib/http";
import { resolveOrderAccessFor } from "@/lib/orders/access";
import { orderTokenSchema } from "@/lib/validation/checkout";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const bodySchema = z.strictObject({
  releaseFileId: z.string().trim().regex(RELEASE_FILE_ID_RE, { message: "Choose a file to download." }),
  t: orderTokenSchema.nullish(),
});

const NO_STORE = { "cache-control": "no-store, max-age=0", pragma: "no-cache" };

export const POST = route<Context>(async (req, { params }) => {
  const { id } = await params;
  const auth = await getCurrentAuth();
  assertCheckoutCsrf(req, auth?.session.id);
  const body = await parseJsonBody(req, bodySchema, { maxBytes: 2048 });
  enforce(await hit(db, RATE_LIMITS.orderActionIp(clientIp(req))));
  const access = await resolveOrderAccessFor(id, { token: orderTokenFrom(req, body.t), auth });
  assertCanDownloadFromOrder(access);
  const actor = orderDownloadActor(access);
  enforce(await hit(db, RATE_LIMITS.downloads(actor.eventUserId)));
  const link = await issueDownload(db, {
    fileId: body.releaseFileId,
    scope: { kind: "order", orderId: access.order.id },
    eventUserId: actor.eventUserId,
    actorName: actor.actorName,
    ttlSec: await currentDownloadTtl(db),
  });
  return json(link, { headers: NO_STORE });
});
