/**
 * POST /api/account/downloads { releaseFileId } (api-contracts section 5, decisions.md Phase 4).
 * Signed-in customer with a verified email whose team role has `downloads` (Owner, Technical): 401 / 403.
 * CSRF + same origin. 30 links per hour per user (RATE_LIMITS.downloads, counted before the entitlement check).
 * The account's best license for the file's product must entitle the release: else 403 `not_entitled` with `reason`
 * (no_license, revoked, suspended, expired, updates_ended, not_released). Unknown file 404.
 * 200 { url, expiresAt, ttlSec, fileId, fileName, platform, version, sizeLabel, licenseId }: a presigned GET valid for
 * min(setting, DOWNLOAD_LINK_TTL_SECONDS, 600) seconds. Writes DownloadEvent + "Downloaded installer" activity.
 * Always Cache-Control: no-store (the URL is a short-lived credential).
 */
import { z } from "zod";
import { assertCsrf, csrfBinding } from "@/lib/auth/csrf";
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { currentDownloadTtl, requireVerifiedAccount } from "@/lib/downloads/access";
import { issueDownload } from "@/lib/downloads/issue";
import { RELEASE_FILE_ID_RE } from "@/lib/downloads/model";
import { getEnv } from "@/lib/env";
import { json, parseJsonBody, route } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.strictObject({
  releaseFileId: z.string().trim().regex(RELEASE_FILE_ID_RE, { message: "Choose a file to download." }),
});

const NO_STORE = { "cache-control": "no-store, max-age=0", pragma: "no-cache" };

export const POST = route(async (req) => {
  const ctx = await requireVerifiedAccount("downloads");
  const env = getEnv();
  assertCsrf(req, { binding: csrfBinding(ctx.session.id), secret: env.CSRF_SECRET, appUrl: env.APP_URL });
  const body = await parseJsonBody(req, bodySchema, { maxBytes: 1024 });
  enforce(await hit(db, RATE_LIMITS.downloads(ctx.user.id)));
  const link = await issueDownload(db, {
    fileId: body.releaseFileId,
    scope: { kind: "account", accountId: ctx.account.id },
    eventUserId: ctx.user.id,
    actorName: ctx.user.name,
    ttlSec: await currentDownloadTtl(db),
  });
  return json(link, { headers: NO_STORE });
});
