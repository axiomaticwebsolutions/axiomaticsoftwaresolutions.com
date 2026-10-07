/**
 * Trusted-device cookie for two-step sign-in (docs/decisions.md, Phase 3 "Auth").
 *
 * After a successful two-step code with "trust this device", the browser gets `axs_td` =
 * "2.<securityEpoch>.<expiry>.<signature>", where the signature is HMAC-SHA256(SESSION_SECRET) over the user id, the
 * user's security epoch, the expiry (unix seconds) and a fingerprint of the current password hash. Nothing identifying
 * is in the cookie itself. A sign-in skips the emailed code only when the signature verifies for THAT user, the expiry
 * is in the future, the epoch is still the user's current User.securityEpoch and the password has not changed since.
 * The epoch is bumped (docs/decisions.md Phase 7) on password reset and change, staff deactivation, reactivation and
 * role change, and when two-step is turned off, which invalidates every trusted device of that user at once; the
 * password fingerprint stays as a second, independent binding. Version 1 cookies (no epoch) no longer verify. 30 days.
 *
 * httpOnly, SameSite=Lax, Secure over https, scoped to /api/auth (only the sign-in routes ever read it).
 */
import "server-only";
import { cookies } from "next/headers";
import { cookieSecure } from "@/lib/auth/cookies";
import { hmacSha256, safeEqual, sha256Hex } from "@/lib/auth/tokens";
import { DAY_MS } from "@/lib/dates";

export const TRUSTED_DEVICE_COOKIE = "axs_td";
export const TRUSTED_DEVICE_TTL_MS = 30 * DAY_MS;
export const TRUSTED_DEVICE_COOKIE_PATH = "/api/auth";

const VERSION = "2";
const MAX_COOKIE_LENGTH = 256;

export type TrustedDeviceSubject = {
  userId: string;
  /** The user's current argon2 hash; null (no password) never verifies. */
  passwordHash: string | null;
  /** The user's current User.securityEpoch. */
  securityEpoch: number;
  secret: string;
};

function signature(subject: TrustedDeviceSubject & { passwordHash: string }, expSec: number): string {
  return hmacSha256(
    subject.secret,
    `td:${VERSION}:${subject.userId}:${subject.securityEpoch}:${expSec}:${sha256Hex(subject.passwordHash)}`,
  );
}

function validEpoch(epoch: number): boolean {
  return Number.isSafeInteger(epoch) && epoch >= 0;
}

/** Mints the cookie value for a user, or null when the user has no password (or the epoch is not a whole number). */
export function issueTrustedDevice(
  subject: TrustedDeviceSubject,
  now: Date = new Date(),
): { value: string; expiresAt: Date } | null {
  if (!subject.passwordHash || !validEpoch(subject.securityEpoch)) return null;
  const expSec = Math.floor((now.getTime() + TRUSTED_DEVICE_TTL_MS) / 1000);
  return {
    value: `${VERSION}.${subject.securityEpoch}.${expSec}.${signature({ ...subject, passwordHash: subject.passwordHash }, expSec)}`,
    expiresAt: new Date(expSec * 1000),
  };
}

/** True when `value` is a live trusted-device cookie for this user, epoch and password. Constant-time signature check. */
export function verifyTrustedDevice(value: string | null | undefined, subject: TrustedDeviceSubject, now: Date = new Date()): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_COOKIE_LENGTH) return false;
  if (!subject.passwordHash || !validEpoch(subject.securityEpoch)) return false;
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  const [version, epochText, expText, sig] = parts;
  if (version !== VERSION || !epochText || !expText || !sig || !/^[0-9]{1,12}$/.test(expText)) return false;
  // A cookie from before the latest security event: refuse without computing anything else.
  if (epochText !== String(subject.securityEpoch)) return false;
  const expSec = Number(expText);
  if (!Number.isSafeInteger(expSec) || expSec * 1000 <= now.getTime()) return false;
  // A forged far-future expiry still needs a valid signature; also refuse anything beyond the maximum lifetime.
  if (expSec * 1000 > now.getTime() + TRUSTED_DEVICE_TTL_MS + 60_000) return false;
  return safeEqual(sig, signature({ ...subject, passwordHash: subject.passwordHash }, expSec));
}

const cookieOptions = () =>
  ({ httpOnly: true, sameSite: "lax", path: TRUSTED_DEVICE_COOKIE_PATH, secure: cookieSecure() }) as const;

/** Route handlers only. */
export async function setTrustedDeviceCookie(value: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(TRUSTED_DEVICE_COOKIE, value, { ...cookieOptions(), expires: expiresAt });
}

export async function readTrustedDeviceCookie(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(TRUSTED_DEVICE_COOKIE)?.value;
  return value ? value : null;
}

export async function clearTrustedDeviceCookie(): Promise<void> {
  const store = await cookies();
  store.set(TRUSTED_DEVICE_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
}
