/**
 * POST /api/account/licenses/:id/reveal { password } -> 200 { key, hideAt } with Cache-Control: no-store.
 * Team permission `keys.reveal` (Owner, Technical), CSRF + same origin, verified email. Password re-auth with
 * 5 checks / 15 min per user (counted before verifying, cleared on success): 422 `incorrect_password`, 429
 * `too_many_attempts` with Retry-After. 409 `license_revoked`; 404 outside the account. Logs `key_revealed` and the
 * "Revealed license key" activity; the key itself is never logged or stored.
 */
import { db } from "@/lib/db";
import { errors, json, parseJsonBody, route } from "@/lib/http";
import { requireLicenseMember } from "@/lib/licensing/account";
import { revealLicenseKey } from "@/lib/licensing/reveal";
import { isLicenseIdShape, LICENSE_ACTION_BODY_MAX_BYTES, revealKeySchema } from "@/lib/validation/license-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req, ctx) => {
  const member = await requireLicenseMember(req, { perm: "keys.reveal", mutation: true });
  const { id } = await ctx.params;
  const { password } = await parseJsonBody(req, revealKeySchema, { maxBytes: LICENSE_ACTION_BODY_MAX_BYTES });
  if (!isLicenseIdShape(id)) throw errors.notFound("License");
  const revealed = await revealLicenseKey(
    { accountId: member.account.id, user: { id: member.user.id, name: member.user.name }, licenseId: id, password },
    db,
  );
  return json(
    { key: revealed.key, hideAt: revealed.hideAt.toISOString() },
    { headers: { "cache-control": "no-store, max-age=0", pragma: "no-cache" } },
  );
});
