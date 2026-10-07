/**
 * Shared pieces of the auth flows (lib/auth/flows/*): lifetimes, user-facing copy (Account.dc.html), keyed code
 * hashes, opaque "<id>.<secret>" tokens, local rate-limit rules and small helpers.
 *
 * Secrets handling: emailed codes and reset links are never stored. AuthToken.codeHash holds an HMAC keyed with
 * SESSION_SECRET (codes: only 10^6 values, so a plain hash of a leaked row would be brute-forced offline) or the
 * SHA-256 of a 256-bit secret (reset links, challenge ids). Logs never carry codes, links, tokens or passwords.
 */
import "server-only";
import { Prisma, type AuthTokenType, type User } from "@/generated/prisma/client";
import { hmacSha256, randomToken, safeEqual, sha256Hex } from "@/lib/auth/tokens";
import type { Db, Tx } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ApiError, errors } from "@/lib/http";

export const EMAIL_CODE_TTL_MS = 15 * 60_000;
export const LOGIN_CODE_TTL_MS = 10 * 60_000;
export const RESET_TOKEN_TTL_MS = 30 * 60_000;
/** Wrong guesses allowed per emailed code (verification and two-step). */
export const MAX_CODE_ATTEMPTS = 5;
/** "{n} attempts left." appears once this many sign-in attempts were counted for the email. */
export const ATTEMPTS_LEFT_FROM = 3;

export const AUTH_MESSAGES = {
  invalidCredentials: "Email or password is incorrect.",
  emailTaken: "An account with this email already exists. Sign in instead.",
  invalidCode: "That code is not correct. Check the latest email we sent.",
  verifySignedOut: "Sign in again to verify your email.",
  codeExpired: "This code has expired. Request a new code.",
  codeAttemptsUsed: "Too many attempts. Request a new code.",
  loginCodeExpired: "This code has expired. Sign in again to get a new code.",
  loginCodeAttemptsUsed: "Too many attempts. Sign in again to get a new code.",
  resetInvalid: "This reset link isn’t valid. Request a new one.",
  resetUsed: "This reset link has already been used. Request a new one.",
  resetExpired: "This reset link has expired. Request a new one.",
  currentPasswordWrong: "Your current password is incorrect.",
  sessionNotFound: "That session has already ended.",
} as const;

export type AuthRequestContext = {
  /** Client IP from lib/http clientIp() (null when unknown). */
  ip: string | null;
  userAgent: string | null;
  now?: Date;
};

export const nowOf = (ctx: { now?: Date }) => ctx.now ?? new Date();

function minutesText(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** "1 minute", "25 minutes", "1 hour", "23 hours": how long until a limit lifts. */
export function waitText(retryAfterSec: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
  if (minutes < 60) return minutesText(retryAfterSec);
  const hours = Math.ceil(minutes / 60);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

/** 429 for a locked sign-in (per email or per IP). Copy: Account.dc.html. */
export function signInLockedError(retryAfterSec: number): ApiError {
  return errors.rateLimited(retryAfterSec, `Too many attempts. Try again in ${minutesText(retryAfterSec)}, or reset your password.`);
}

/** "Email or password is incorrect." plus " 2 attempts left." once ATTEMPTS_LEFT_FROM attempts were counted. */
export function invalidCredentialsError(countedForEmail: number, limit: number): ApiError {
  const left = limit - countedForEmail;
  let message: string = AUTH_MESSAGES.invalidCredentials;
  if (countedForEmail >= ATTEMPTS_LEFT_FROM && left > 0) message += ` ${left} ${left === 1 ? "attempt" : "attempts"} left.`;
  return new ApiError(401, "invalid_credentials", message);
}

export const invalidCodeError = () => new ApiError(422, "invalid_code", AUTH_MESSAGES.invalidCode);
export const codeExpiredError = (message: string = AUTH_MESSAGES.codeExpired) => new ApiError(410, "code_expired", message);
export const resetInvalidError = (message: string = AUTH_MESSAGES.resetInvalid) => new ApiError(422, "token_invalid", message);
export const resetExpiredError = () => new ApiError(410, "token_expired", AUTH_MESSAGES.resetExpired);

/** Keyed hash of an emailed code, bound to its purpose, the user and the address it was sent to. */
export function hashCode(purpose: "email_verify" | "login_otp", userId: string, email: string, code: string): string {
  return hmacSha256(getEnv().SESSION_SECRET, `${purpose}:${userId}:${email}:${code}`);
}

export function codeMatches(stored: string, purpose: "email_verify" | "login_otp", userId: string, email: string, code: string): boolean {
  return safeEqual(stored, hashCode(purpose, userId, email, code));
}

/** A fresh 256-bit secret for "<id>.<secret>" tokens, with the SHA-256 that gets stored. */
export function newOpaqueSecret(): { secret: string; hash: string } {
  const secret = randomToken(32);
  return { secret, hash: sha256Hex(secret) };
}

/** Splits "<id>.<secret>" (reset tokens, two-step challenge ids). Null when malformed. */
export function splitOpaqueToken(value: string): { id: string; secret: string } | null {
  const dot = value.indexOf(".");
  if (dot <= 0 || dot !== value.lastIndexOf(".")) return null;
  const id = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (id.length > 64 || secret.length < 32 || secret.length > 128) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id) || !/^[A-Za-z0-9_-]+$/.test(secret)) return null;
  return { id, secret };
}

/** Constant-time check of a presented secret against the stored SHA-256. */
export function secretMatches(secret: string, storedHash: string | null | undefined): boolean {
  if (typeof storedHash !== "string" || storedHash.length === 0) return false;
  return safeEqual(sha256Hex(secret), storedHash);
}

/** "p•••@sharmamedicals.example": enough to recognise the address, not to harvest it. */
export function emailHint(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "•••";
  return `${email.charAt(0)}•••${email.slice(at)}`;
}

/** Normalised identity used for lookups (User.email and Order.email are stored lower-case). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Marks every unused token of these types for the user as used (a newer code or link supersedes them). */
export async function invalidateUserTokens(client: Db, userId: string, types: AuthTokenType[], now: Date): Promise<number> {
  const { count } = await client.authToken.updateMany({
    where: { userId, type: { in: types }, usedAt: null },
    data: { usedAt: now },
  });
  return count;
}

/** True for the unique-constraint violation Prisma raises on a duplicate key (e.g. User.email). */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Whether the user may sign in at all: customers always; staff only while ACTIVE (invited and deactivated cannot). */
export function canSignIn(user: Pick<User, "kind" | "staffStatus">): boolean {
  return user.kind === "CUSTOMER" || user.staffStatus === "ACTIVE";
}

/** Reads a string field of AuthToken.meta (never secrets: `next`, the challenge hash). */
export function metaString(meta: Prisma.JsonValue | null | undefined, key: string): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const value = (meta as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/**
 * The default active account after sign-in: the earliest account the customer is an active OWNER of, including one
 * they joined by invitation and were later made Owner of. Never use it to decide where guest orders go (ownAccountId).
 */
export async function ownerAccountId(client: Db, userId: string): Promise<string | null> {
  const membership = await client.accountMember.findFirst({
    where: { userId, role: "OWNER", status: "ACTIVE" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { accountId: true },
  });
  return membership?.accountId ?? null;
}

/**
 * The account a customer's guest orders (and their licenses) are claimed into: the earliest account they created
 * themselves (registration or checkout "Create an account", whose OWNER membership has no invitedAt) and still own.
 * Never an account they joined by invitation, even after an owner there made them Owner: otherwise any Owner could
 * capture a stranger's guest purchases by inviting them and promoting them. Null when they own no account of their
 * own; their guest orders then stay unclaimed (still reachable through the order link).
 */
export async function ownAccountId(client: Db, userId: string): Promise<string | null> {
  const membership = await client.accountMember.findFirst({
    where: { userId, role: "OWNER", status: "ACTIVE", invitedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { accountId: true },
  });
  return membership?.accountId ?? null;
}

/**
 * A placeholder user: created by a team invitation for an address without an account (lib/portal/team.ts), with no
 * password, no name and an unverified email, until the person accepts. It must never block that address from
 * creating its own account, so registration and checkout take it over (takeOverPlaceholderUser).
 */
export const PLACEHOLDER_USER_WHERE = { kind: "CUSTOMER", passwordHash: null, emailVerifiedAt: null } as const satisfies Prisma.UserWhereInput;

export function isPlaceholderUser(user: Pick<User, "kind" | "passwordHash" | "emailVerifiedAt">): boolean {
  return user.kind === "CUSTOMER" && user.passwordHash === null && user.emailVerifiedAt === null;
}

/**
 * Inside the registering transaction (POST /api/auth/register, checkout "Create an account"): gives the placeholder
 * user of `email` the person's name, password and phone. Conditional on the row still being a placeholder, so a
 * concurrent acceptance or registration wins only once. Pending invitations stay as they are (the person can accept
 * them after signing in). Returns null when no placeholder holds the email; the caller then creates the user as usual
 * (and a unique violation still means 409 email_taken).
 */
export async function takeOverPlaceholderUser(
  tx: Tx,
  input: { email: string; name: string; passwordHash: string; phone?: string | null; now: Date },
): Promise<User | null> {
  const { count } = await tx.user.updateMany({
    where: { email: input.email, ...PLACEHOLDER_USER_WHERE },
    data: {
      name: input.name,
      passwordHash: input.passwordHash,
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      lastActiveAt: input.now,
      createdAt: input.now,
    },
  });
  if (count !== 1) return null;
  return tx.user.findUniqueOrThrow({ where: { email: input.email } });
}
