/**
 * Password-gated license key reveal (api-contracts section 5; decisions.md 10 and Phase 4): a member with
 * `keys.reveal` re-enters their account password to see one license's full key for 60 seconds.
 *
 * Order: account-scoped lookup (404 outside the account), 409 for revoked licenses, then the password check guarded
 * by RATE_LIMITS.keyReveal (5 checks / 15 min per user, counted BEFORE verifying so concurrent guesses cannot pass the
 * limit; cleared on success), 422 `incorrect_password`, then decrypt in memory and record a `key_revealed`
 * LicenseEvent (actor = member name) plus the "Revealed license key" security activity. The key is returned to the
 * caller only: it is never logged, never written to any table and never part of an event detail.
 */
import "server-only";
import { LicenseStatus, type PrismaClient } from "@/generated/prisma/client";
import { verifyPassword } from "@/lib/auth/password";
import { attempt, clear, RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db as defaultDb } from "@/lib/db";
import { getLicenseKeySecrets } from "@/lib/env";
import { ApiError, errors, INTERNAL_ERROR_MESSAGE } from "@/lib/http";
import { log } from "@/lib/log";
import { decryptLicenseKey, type LicenseKeySecrets } from "./crypto";

/** The portal hides a revealed key again after 60 s (prototype "auto-hides after 60 s"). */
export const KEY_REVEAL_SECONDS = 60;
/** Portal copy (prototype revealKey). */
export const INCORRECT_PASSWORD_MESSAGE = "Incorrect password.";
export const REVEAL_REVOKED_MESSAGE = "This license was revoked, so its key can\u2019t be revealed.";

export type RevealLicenseKeyInput = {
  /** The caller's server-side active account (requireAccountRole); never from the client. */
  accountId: string;
  user: { id: string; name: string };
  licenseId: string;
  password: string;
  now?: Date;
  secrets?: LicenseKeySecrets;
};

export type RevealedLicenseKey = { licenseId: string; key: string; hideAt: Date };

export function incorrectPassword(): ApiError {
  return new ApiError(422, "incorrect_password", INCORRECT_PASSWORD_MESSAGE, {
    details: { fieldErrors: { password: [INCORRECT_PASSWORD_MESSAGE] }, formErrors: [] },
  });
}

export async function revealLicenseKey(input: RevealLicenseKeyInput, client: PrismaClient = defaultDb): Promise<RevealedLicenseKey> {
  const now = input.now ?? new Date();
  const license = await client.license.findFirst({
    where: { id: input.licenseId, accountId: input.accountId },
    select: { id: true, status: true, keyCiphertext: true },
  });
  if (!license) throw errors.notFound("License");
  if (license.status === LicenseStatus.REVOKED) throw errors.conflict("license_revoked", REVEAL_REVOKED_MESSAGE);

  // Count the password check before running it; a refused attempt is not counted (lib/auth/rate-limit.ts).
  const rule = RATE_LIMITS.keyReveal(input.user.id);
  const counted = await attempt(client, rule, now);
  if (!counted.allowed) {
    log.warn("license_key_reveal_limited", { userId: input.user.id, licenseId: license.id });
    throw errors.rateLimited(counted.retryAfterSec);
  }
  // Re-read the hash: the session's copy of the user may be stale (e.g. right after a password change).
  const user = await client.user.findUnique({ where: { id: input.user.id }, select: { passwordHash: true } });
  if (!(await verifyPassword(input.password, user?.passwordHash))) {
    log.info("license_key_reveal_denied", { userId: input.user.id, licenseId: license.id, remaining: counted.remaining });
    throw incorrectPassword();
  }
  await clear(client, rule.key);

  let key: string;
  try {
    key = decryptLicenseKey(license.keyCiphertext, (input.secrets ?? getLicenseKeySecrets()).encKey);
  } catch (error) {
    log.error("license_key_decrypt_failed", { licenseId: license.id, error });
    throw new ApiError(500, "internal_error", INTERNAL_ERROR_MESSAGE);
  }

  await client.$transaction([
    client.licenseEvent.create({
      data: { licenseId: license.id, type: "key_revealed", actor: input.user.name.slice(0, 200), detail: null, createdAt: now },
    }),
    client.accountActivity.create({
      data: {
        accountId: input.accountId,
        actorId: input.user.id,
        actorName: input.user.name.slice(0, 200),
        action: "Revealed license key",
        target: license.id,
        kind: "security",
        createdAt: now,
      },
    }),
  ]);
  log.info("license_key_revealed", { licenseId: license.id, userId: input.user.id, accountId: input.accountId });
  return { licenseId: license.id, key, hideAt: new Date(now.getTime() + KEY_REVEAL_SECONDS * 1000) };
}
