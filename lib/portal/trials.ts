/**
 * Free trials from the portal (decisions.md section 6 and Phase 5; storefront "Start free trial" continues to
 * /account/software?trial=<slug>, which calls POST /api/account/trials). One trial per product per account
 * (409 `trial_used`), a verified email (403 `email_unverified`), a published product with a live trial plan (404 /
 * 422 `trial_unavailable`); team permission `trials.start` (Owner, Billing admin, Technical contact) is checked by the
 * route. The license is issued through startTrial() (lib/licensing/issue.ts) with its `trial_started` event, plus a
 * "Started free trial" license activity entry in the same transaction.
 *
 * The response never carries the full key: decisions.md "Key reveal always requires the password", and a Billing admin
 * may start trials but may not see keys. The portal opens the new license, where Owner and Technical can reveal it.
 */
import "server-only";
import { db as defaultDb } from "@/lib/db";
import { startTrial } from "@/lib/licensing/issue";
import { maskLicenseKey } from "@/lib/licensing/keys";
import { log } from "@/lib/log";
import { actorLabel, recordAccountActivity } from "@/lib/portal/activity";

/** New activity wording (the prototype has no in-portal trial start). */
export const TRIAL_ACTIVITY_ACTION = "Started free trial";

export type StartedTrial = {
  license: {
    id: string;
    productId: string;
    productName: string;
    productShortName: string;
    planName: string;
    status: "trial";
    keyMasked: string;
    issuedAt: string;
    expiresAt: string | null;
    deviceLimit: number;
  };
  /** The new license in the portal. */
  href: string;
};

export type StartPortalTrialInput = {
  /** The caller's server-side active account (never from the client). */
  accountId: string;
  user: { id: string; name: string; email: string; emailVerifiedAt: Date | null };
  productId: string;
  now?: Date;
};

export async function startPortalTrial(input: StartPortalTrialInput, client: typeof defaultDb = defaultDb): Promise<StartedTrial> {
  const at = input.now ?? new Date();
  const actorName = actorLabel(input.user);
  const started = await client.$transaction(async (tx) => {
    const { license } = await startTrial(tx, {
      accountId: input.accountId,
      productId: input.productId,
      user: { id: input.user.id, name: actorName, emailVerifiedAt: input.user.emailVerifiedAt },
      at,
    });
    const details = await tx.license.findUniqueOrThrow({
      where: { id: license.id },
      select: {
        id: true,
        keyLast4: true,
        issuedAt: true,
        expiresAt: true,
        deviceLimit: true,
        plan: { select: { name: true } },
        product: { select: { id: true, code: true, name: true, shortName: true } },
      },
    });
    await recordAccountActivity(tx, {
      accountId: input.accountId,
      actor: { id: input.user.id, name: actorName },
      action: TRIAL_ACTIVITY_ACTION,
      target: `${details.id} \u00b7 ${details.product.shortName}`,
      kind: "license",
      at,
    });
    return details;
  });
  log.info("trial_started", { accountId: input.accountId, licenseId: started.id, productId: started.product.id });
  return {
    license: {
      id: started.id,
      productId: started.product.id,
      productName: started.product.name,
      productShortName: started.product.shortName,
      planName: started.plan.name,
      status: "trial",
      keyMasked: maskLicenseKey(started.product.code, started.keyLast4),
      issuedAt: started.issuedAt.toISOString(),
      expiresAt: started.expiresAt ? started.expiresAt.toISOString() : null,
      deviceLimit: started.deviceLimit,
    },
    href: `/account/licenses/${encodeURIComponent(started.id)}`,
  };
}
