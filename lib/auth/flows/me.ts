/**
 * The signed-in user's own data: GET /api/me and "Active sessions" (list, sign out one, sign out all others).
 * Every query is scoped to the session's user; ids from the client are only ever matched within that scope.
 */
import "server-only";
import type { Session, StaffRole, TeamRole, User, UserKind } from "@/generated/prisma/client";
import { activeAccountIdFor, recordSecurityActivity } from "@/lib/auth/flows/activity";
import { AUTH_MESSAGES } from "@/lib/auth/flows/common";
import { listSessions, revokeAllSessions } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { log } from "@/lib/log";

export type MeResponse = {
  user: { id: string; name: string; email: string; kind: UserKind; emailVerified: boolean; staffRole: StaffRole | null };
  account: { id: string; legalName: string } | null;
  role: TeamRole | null;
};

export async function getMe(auth: { user: User; session: Session }): Promise<MeResponse> {
  const { user } = auth;
  const base: MeResponse["user"] = {
    id: user.id,
    name: user.name,
    email: user.email,
    kind: user.kind,
    emailVerified: Boolean(user.emailVerifiedAt),
    staffRole: user.kind === "STAFF" ? user.staffRole : null,
  };
  const accountId = await activeAccountIdFor(db, user, auth.session);
  if (!accountId) return { user: base, account: null, role: null };
  const membership = await db.accountMember.findFirst({
    where: { accountId, userId: user.id, status: "ACTIVE" },
    select: { role: true, account: { select: { id: true, legalName: true } } },
  });
  if (!membership) return { user: base, account: null, role: null };
  return { user: base, account: membership.account, role: membership.role };
}

/** "Chrome on Windows" from a User-Agent; "Unknown device" when nothing is recognised. */
export function deviceLabel(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser\//.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS\//.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : null;
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iPod/.test(ua)
        ? "iOS"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Unknown device";
}

export type SessionView = {
  id: string;
  current: boolean;
  device: string;
  mobile: boolean;
  userAgent: string | null;
  ipPrefix: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
};

export async function listMySessions(auth: { user: User; session: Session }, now: Date = new Date()): Promise<SessionView[]> {
  const sessions = await listSessions(db, auth.user.id, now);
  const views = sessions.map((s) => ({
    id: s.id,
    current: s.id === auth.session.id,
    device: deviceLabel(s.userAgent),
    mobile: /Android|iPhone|iPad|iPod|Mobile/.test(s.userAgent ?? ""),
    userAgent: s.userAgent,
    ipPrefix: s.ipPrefix,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    expiresAt: s.expiresAt.toISOString(),
  }));
  // This device first, then most recently used.
  return views.sort((a, b) => Number(b.current) - Number(a.current));
}

/** "Sign out all others": revokes every other live session of the user. */
export async function revokeOtherSessions(auth: { user: User; session: Session }, now: Date = new Date()): Promise<{ revoked: number }> {
  const revoked = await db.$transaction(async (tx) => {
    const count = await revokeAllSessions(tx, auth.user.id, { exceptSessionId: auth.session.id, now });
    await recordSecurityActivity(tx, auth, { action: "Signed out all other sessions", target: "", now });
    return count;
  });
  log.info("other_sessions_revoked", { userId: auth.user.id, revoked });
  return { revoked };
}

/**
 * Signs out one of the user's sessions. 404 when it is not theirs, unknown or already ended.
 * `current` tells the route to clear the cookie (the user signed this device out).
 */
export async function revokeMySession(
  auth: { user: User; session: Session },
  sessionId: string,
  now: Date = new Date(),
): Promise<{ current: boolean; device: string }> {
  const result = await db.$transaction(async (tx) => {
    const target = await tx.session.findFirst({
      where: { id: sessionId, userId: auth.user.id, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true, userAgent: true },
    });
    if (!target) return null;
    const { count } = await tx.session.updateMany({ where: { id: target.id, revokedAt: null }, data: { revokedAt: now } });
    if (count === 0) return null;
    const device = deviceLabel(target.userAgent);
    await recordSecurityActivity(tx, auth, { action: "Signed out session", target: device, now });
    return { current: target.id === auth.session.id, device };
  });
  if (!result) throw new ApiError(404, "not_found", AUTH_MESSAGES.sessionNotFound);
  log.info("session_revoked", { userId: auth.user.id, sessionId, current: result.current });
  return result;
}
