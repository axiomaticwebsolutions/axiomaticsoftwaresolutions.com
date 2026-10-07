/**
 * GET /api/account/search?q= -> 200 { q, results: [{ type, typeLabel, icon, id, title, sub, href }] }: licenses
 * (id, product, key last 4 or a full pasted key), devices (name), orders (id, invoice number) and tickets (id,
 * subject) of the active business account; at least 2 characters (fewer answer an empty list), at most 20 results.
 * Any team role, verified email; 120 searches / min per user (429). The query is never logged. no-store.
 */
import { enforce, hit, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { json, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { searchAccount } from "@/lib/portal/search";
import { parseSearchQuery } from "@/lib/validation/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = route(async (req) => {
  const ctx = await requireLicenseMember(req, { perm: "licenses.view" });
  const q = parseSearchQuery(req.nextUrl.searchParams);
  enforce(await hit(db, RATE_LIMITS.accountSearch(ctx.user.id)));
  return json(await searchAccount(db, ctx.account.id, q));
});
