import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_IDLE_MS,
  createSession,
  listSessions,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  rotateSession,
} from "@/lib/auth/sessions";
import { sha256Hex } from "@/lib/auth/tokens";
import { db } from "@/lib/db";

const T0 = new Date("2026-10-06T06:30:00.000Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const MINUTE = 60_000;

const uniqueEmail = (name: string) => `${name}.${randomBytes(4).toString("hex")}@example.test`;

async function customer() {
  return db.user.create({ data: { email: uniqueEmail("priya"), name: "Priya Sharma", kind: "CUSTOMER" } });
}

async function staff() {
  return db.user.create({
    data: { email: uniqueEmail("sneha"), name: "Sneha Patil", kind: "STAFF", staffRole: "SUPPORT", staffStatus: "ACTIVE" },
  });
}

beforeEach(async () => {
  await db.session.deleteMany({});
});

describe("createSession / resolveSession", () => {
  it("stores only the token hash and resolves the token back to the user", async () => {
    const user = await customer();
    const { token, session } = await createSession(db, {
      userId: user.id,
      kind: "CUSTOMER",
      ip: "103.21.44.17",
      userAgent: "Mozilla/5.0",
      now: T0,
    });
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(session.tokenHash).toBe(sha256Hex(token));
    expect(session.tokenHash).not.toContain(token);
    expect(session.ipPrefix).toBe("103.21.44.x");
    expect(session.expiresAt).toEqual(later(SESSION_IDLE_MS.CUSTOMER));

    const resolved = await resolveSession(db, token, later(MINUTE));
    expect(resolved?.session.id).toBe(session.id);
    expect(resolved?.user.id).toBe(user.id);
  });

  it("returns null for unknown, empty and oversized tokens", async () => {
    expect(await resolveSession(db, "nope", T0)).toBeNull();
    expect(await resolveSession(db, "", T0)).toBeNull();
    expect(await resolveSession(db, null, T0)).toBeNull();
    expect(await resolveSession(db, "x".repeat(500), T0)).toBeNull();
  });

  it("expires after the idle window (12 hours for staff)", async () => {
    const user = await staff();
    const { token, session } = await createSession(db, { userId: user.id, kind: "STAFF", now: T0 });
    expect(session.expiresAt).toEqual(later(12 * 60 * MINUTE));
    expect(await resolveSession(db, token, later(12 * 60 * MINUTE + 1))).toBeNull();
  });

  it("slides the idle window when the session is used", async () => {
    const user = await staff();
    const { token } = await createSession(db, { userId: user.id, kind: "STAFF", now: T0 });
    // Activity at 11h pushes expiry to 23h, so the session outlives its original 12h expiry...
    expect(await resolveSession(db, token, later(11 * 60 * MINUTE))).not.toBeNull();
    expect(await resolveSession(db, token, later(13 * 60 * MINUTE))).not.toBeNull();
    // ...the 13h touch moved it again to 25h, after which it lapses without further use.
    expect(await resolveSession(db, token, later(25 * 60 * MINUTE + 1))).toBeNull();
  });

  it("slides the idle expiry, but only when lastSeenAt is over 5 minutes old", async () => {
    const user = await customer();
    const { token, session } = await createSession(db, { userId: user.id, kind: "CUSTOMER", now: T0 });

    const early = await resolveSession(db, token, later(2 * MINUTE));
    expect(early?.session.lastSeenAt).toEqual(T0);
    expect((await db.session.findUniqueOrThrow({ where: { id: session.id } })).lastSeenAt).toEqual(T0);

    const touchedAt = later(10 * MINUTE);
    const touched = await resolveSession(db, token, touchedAt);
    expect(touched?.session.lastSeenAt).toEqual(touchedAt);
    expect(touched?.session.expiresAt).toEqual(new Date(touchedAt.getTime() + SESSION_IDLE_MS.CUSTOMER));
    const row = await db.session.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.lastSeenAt).toEqual(touchedAt);
    expect(row.expiresAt).toEqual(new Date(touchedAt.getTime() + SESSION_IDLE_MS.CUSTOMER));
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).lastActiveAt).toEqual(touchedAt);
  });

  it("rejects sessions of deactivated staff", async () => {
    const user = await staff();
    const { token } = await createSession(db, { userId: user.id, kind: "STAFF", now: T0 });
    await db.user.update({ where: { id: user.id }, data: { staffStatus: "DEACTIVATED" } });
    expect(await resolveSession(db, token, later(MINUTE))).toBeNull();
  });
});

describe("revocation", () => {
  it("revokeSession signs one session out", async () => {
    const user = await customer();
    const { token, session } = await createSession(db, { userId: user.id, kind: "CUSTOMER", now: T0 });
    expect(await revokeSession(db, session.id, later(MINUTE))).toBe(true);
    expect(await revokeSession(db, session.id, later(MINUTE))).toBe(false);
    expect(await resolveSession(db, token, later(2 * MINUTE))).toBeNull();
  });

  it("revokeAllSessions can keep the current session", async () => {
    const user = await customer();
    const other = await customer();
    const current = await createSession(db, { userId: user.id, kind: "CUSTOMER", now: T0 });
    const laptop = await createSession(db, { userId: user.id, kind: "CUSTOMER", now: T0 });
    const phone = await createSession(db, { userId: user.id, kind: "CUSTOMER", now: T0 });
    const stranger = await createSession(db, { userId: other.id, kind: "CUSTOMER", now: T0 });

    expect(await revokeAllSessions(db, user.id, { exceptSessionId: current.session.id, now: later(MINUTE) })).toBe(2);
    expect(await resolveSession(db, current.token, later(2 * MINUTE))).not.toBeNull();
    expect(await resolveSession(db, laptop.token, later(2 * MINUTE))).toBeNull();
    expect(await resolveSession(db, phone.token, later(2 * MINUTE))).toBeNull();
    expect(await resolveSession(db, stranger.token, later(2 * MINUTE))).not.toBeNull();

    const listed = await listSessions(db, user.id, later(2 * MINUTE));
    expect(listed.map((s) => s.id)).toEqual([current.session.id]);
    expect(listed[0]).not.toHaveProperty("tokenHash");

    expect(await revokeAllSessions(db, user.id, { now: later(3 * MINUTE) })).toBe(1);
    expect(await resolveSession(db, current.token, later(4 * MINUTE))).toBeNull();
  });

  it("rotateSession revokes the old session and issues a new token", async () => {
    const user = await customer();
    const before = await createSession(db, { userId: user.id, kind: "CUSTOMER", now: T0 });
    const after = await rotateSession(db, before.session.id, { userId: user.id, kind: "CUSTOMER", now: later(MINUTE) });
    expect(after.token).not.toBe(before.token);
    expect(await resolveSession(db, before.token, later(2 * MINUTE))).toBeNull();
    expect((await resolveSession(db, after.token, later(2 * MINUTE)))?.session.id).toBe(after.session.id);
  });
});
