/**
 * Per-user email preferences (portal Notifications > "Email preferences"; decisions.md Phase 5): four switches stored
 * in User.notificationPrefs as { renewals, updates, tickets, offers, offersConsentAt, offersWithdrawnAt }.
 * Defaults (no stored value): renewals, updates and tickets on, offers off. Turning offers on records the consent time
 * (DPDP); turning it off clears it and records the withdrawal time. Security alerts and invoices are always sent and
 * are not preferences. Writes lock the user row so two quick toggles never overwrite each other.
 */
import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { Db, Tx } from "@/lib/db";
import { db as defaultDb } from "@/lib/db";
import { errors } from "@/lib/http";
import { DEFAULT_EMAIL_PREFS, EMAIL_PREF_KEYS, type EmailPrefKey, type EmailPrefsPatch } from "@/lib/validation/portal";

export { DEFAULT_EMAIL_PREFS, EMAIL_PREF_LABELS } from "@/lib/validation/portal";

export type EmailPrefs = Record<EmailPrefKey, boolean> & {
  /** When the user last turned "Offers & announcements" on (ISO), while it is on; null otherwise. */
  offersConsentAt: string | null;
};

export type StoredEmailPrefs = Record<EmailPrefKey, boolean> & {
  offersConsentAt: string | null;
  offersWithdrawnAt: string | null;
};

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Reads the stored JSON leniently (missing or malformed fields take the defaults); never throws. */
export function readStoredEmailPrefs(json: unknown): StoredEmailPrefs {
  const v = json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const flags = {} as Record<EmailPrefKey, boolean>;
  for (const key of EMAIL_PREF_KEYS) {
    const value = v[key];
    flags[key] = typeof value === "boolean" ? value : DEFAULT_EMAIL_PREFS[key];
  }
  const consent = isoOrNull(v.offersConsentAt);
  // Offers count as on only with a recorded consent time (an "on" flag without one is treated as off).
  const offers = flags.offers && consent !== null;
  return { ...flags, offers, offersConsentAt: offers ? consent : null, offersWithdrawnAt: isoOrNull(v.offersWithdrawnAt) };
}

export function toEmailPrefs(stored: StoredEmailPrefs): EmailPrefs {
  return {
    renewals: stored.renewals,
    updates: stored.updates,
    tickets: stored.tickets,
    offers: stored.offers,
    offersConsentAt: stored.offersConsentAt,
  };
}

/** The stored value after applying `patch` at `now` (pure). Unchanged switches keep their consent times. */
export function applyEmailPrefsPatch(current: StoredEmailPrefs, patch: EmailPrefsPatch, now: Date): StoredEmailPrefs {
  const next: StoredEmailPrefs = { ...current };
  for (const key of EMAIL_PREF_KEYS) {
    const value = patch[key];
    if (value !== undefined) next[key] = value;
  }
  if (patch.offers === true && !current.offers) {
    next.offersConsentAt = now.toISOString();
  } else if (patch.offers === false && current.offers) {
    next.offersConsentAt = null;
    next.offersWithdrawnAt = now.toISOString();
  }
  return next;
}

export async function getEmailPrefs(userId: string, client: Db = defaultDb): Promise<EmailPrefs> {
  const user = await client.user.findUnique({ where: { id: userId }, select: { notificationPrefs: true } });
  if (!user) throw errors.notFound("User");
  return toEmailPrefs(readStoredEmailPrefs(user.notificationPrefs));
}

async function updateInTx(tx: Tx, userId: string, patch: EmailPrefsPatch, now: Date): Promise<EmailPrefs> {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { notificationPrefs: true } });
  if (!user) throw errors.notFound("User");
  const next = applyEmailPrefsPatch(readStoredEmailPrefs(user.notificationPrefs), patch, now);
  await tx.user.update({ where: { id: userId }, data: { notificationPrefs: next as unknown as Prisma.InputJsonValue } });
  return toEmailPrefs(next);
}

/** Applies a partial update for the signed-in user (no activity entry: the prototype logs none for preferences). */
export async function updateEmailPrefs(
  userId: string,
  patch: EmailPrefsPatch,
  opts: { now?: Date; client?: typeof defaultDb } = {},
): Promise<EmailPrefs> {
  const client = opts.client ?? defaultDb;
  const now = opts.now ?? new Date();
  return client.$transaction((tx) => updateInTx(tx, userId, patch, now));
}
