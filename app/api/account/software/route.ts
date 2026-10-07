/**
 * GET /api/account/software (api-contracts section 5: any team role; decisions.md Phase 4).
 * Signed-in customer with a verified email (401 / 403). Per product the account holds a license for: the latest
 * published release, the newest release the account may download, every release with notes, files (platform,
 * file name, size label) and "Included" / "Needs renewal", and a reason when nothing is downloadable
 * (lib/software/view.ts). `canDownload` is false for roles without `downloads` (they may still view).
 * 200 { products, canDownload, downloadLinkMinutes }. Cache-Control: no-store.
 */
import { db } from "@/lib/db";
import { currentDownloadTtl, requireVerifiedAccount } from "@/lib/downloads/access";
import { linkMinutes } from "@/lib/downloads/model";
import { json, route } from "@/lib/http";
import { loadAccountSoftware } from "@/lib/software/load";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async () => {
  const ctx = await requireVerifiedAccount();
  const [view, ttlSec] = await Promise.all([
    loadAccountSoftware(db, { accountId: ctx.account.id, role: ctx.membership.role }),
    currentDownloadTtl(db),
  ]);
  return json({ ...view, downloadLinkMinutes: linkMinutes(ttlSec) }, { headers: { "cache-control": "no-store, max-age=0" } });
});
