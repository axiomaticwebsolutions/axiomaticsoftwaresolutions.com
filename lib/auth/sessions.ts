/**
 * Database sessions. The browser holds an opaque 32-byte token; the database stores only its SHA-256, so a
 * leaked table cannot be replayed. Idle expiry slides forward at most once every 5 minutes per session to keep
 * writes off the hot path. No next/headers here: usable from route handlers, scripts and tests.
 */
import { StaffStatus, type Session, type User, type UserKind } from "@/generated/prisma/client";
import { DAY_MS } from "@/lib/dates";
import type { Db } from "@/lib/db";
import { ipPrefix } from "@/lib/http";
import { log } from "@/lib/log";
import { randomToken, sha256Hex } from "@/lib/auth/tokens";

export const SESSION_IDLE_MS = {
  CUSTOMER: 30 * DAY_MS,
  STAFF: 12 * 60 * 60 * 1000,
} as const satisfies Record<UserKind, number>;

/** lastSeenAt / expiresAt are refreshed only when older than this. */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

const TOKEN_BYTES = 32;
const MAX_TOKEN_LENGTH = 128;
const MAX_USER_AGENT = 512;

export type CreateSessionInput = {
  userId: string;
  kind: UserKind;
  userAgent?: string | null;
  /** Full client IP; only the display prefix ("103.21.44.x") is stored. */
  ip?: string | null;
  activeAccountId?: string | null;
  now?: Date;
};

/** A session as shown in "Signed-in devices" (never includes the token hash). */
export type SessionSummary = Omit<Session, "tokenHash">;

export type ResolvedSession = { session: Session; user: User };

/** Creates a session and returns the raw token (for the cookie) once. Only its hash is persisted. */
export async function createSession(db: Db, input: CreateSessionInput): Promise<{ token: string; session: Session }> {
  const now = input.now ?? new Date();
  const token = randomToken(TOKEN_BYTES);
  const session = await db.session.create({
    data: {
      tokenHash: sha256Hex(token),
      userId: input.userId,
      activeAccountId: input.activeAccountId ?? null,
      userAgent: input.userAgent ? input.userAgent.slice(0, MAX_USER_AGENT) : null,
      ipPrefix: ipPrefix(input.ip),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + SESSION_IDLE_MS[input.kind]),
    },
  });
  return { token, session };
}

/**
 * Looks up a session by its cookie token. Returns null for unknown, revoked or expired sessions and for
 * deactivated staff. Slides the idle expiry (and User.lastActiveAt) when lastSeenAt is over 5 minutes old.
 */
export async function resolveSession(db: Db, token: string | null | undefined, now: Date = new Date()): Promise<ResolvedSession | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const found = await db.session.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
  if (!found) return null;
  const { user, ...session } = found;
  if (session.revokedAt || session.expiresAt.getTime() <= now.getTime()) return null;
  if (user.kind === "STAFF" && user.staffStatus === StaffStatus.DEACTIVATED) return null;

  if (now.getTime() - session.lastSeenAt.getTime() < SESSION_TOUCH_INTERVAL_MS) return { session, user };

  const expiresAt = new Date(now.getTime() + SESSION_IDLE_MS[user.kind]);
  try {
    // updateMany with revokedAt: null so a concurrent sign-out is never undone.
    await db.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastSeenAt: now, expiresAt } });
    await db.user.update({ where: { id: user.id }, data: { lastActiveAt: now } });
  } catch (error) {
    // A failed touch must not sign the user out; the next request retries it.
    log.warn("session_touch_failed", { sessionId: session.id, error });
    return { session, user };
  }
  return { session: { ...session, lastSeenAt: now, expiresAt }, user: { ...user, lastActiveAt: now } };
}

/** Revokes one session. Returns false when it was already revoked or does not exist. */
export async function revokeSession(db: Db, sessionId: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await db.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: now } });
  return count > 0;
}

/**
 * Revokes every live session of a user (password reset, staff deactivation), or every other session
 * when `exceptSessionId` is given (password change, "Sign out all other sessions"). Returns the count.
 */
export async function revokeAllSessions(
  db: Db,
  userId: string,
  opts: { exceptSessionId?: string; now?: Date } = {},
): Promise<number> {
  const { count } = await db.session.updateMany({
    where: { userId, revokedAt: null, ...(opts.exceptSessionId ? { id: { not: opts.exceptSessionId } } : {}) },
    data: { revokedAt: opts.now ?? new Date() },
  });
  return count;
}

/**
 * Replaces a session with a fresh token (sign-in over an existing session, privilege change, 2-step completion)
 * so a token planted before authentication can never be promoted.
 */
export async function rotateSession(
  db: Db,
  oldSessionId: string | null | undefined,
  input: CreateSessionInput,
): Promise<{ token: string; session: Session }> {
  if (oldSessionId) await revokeSession(db, oldSessionId, input.now ?? new Date());
  return createSession(db, input);
}

/** Live sessions of a user, most recently used first. */
export async function listSessions(db: Db, userId: string, now: Date = new Date()): Promise<SessionSummary[]> {
  return db.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: now } },
    orderBy: { lastSeenAt: "desc" },
    omit: { tokenHash: true },
  });
}

/**
 * Housekeeping for the cron job: deletes sessions that expired or were revoked more than `retainDays` ago.
 * Session rows carry no audit value once dead, and the table grows with every sign-in.
 */
export async function purgeDeadSessions(db: Db, opts: { now?: Date; retainDays?: number } = {}): Promise<number> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - (opts.retainDays ?? 30) * DAY_MS);
  const { count } = await db.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  return count;
}
