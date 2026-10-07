import { beforeEach, describe, expect, it, vi } from "vitest";
import { changePassword } from "@/lib/auth/flows/change-password";
import { requestPasswordReset } from "@/lib/auth/flows/forgot-password";
import { getMe, listMySessions, revokeMySession, revokeOtherSessions } from "@/lib/auth/flows/me";
import { inspectResetToken, resetPassword } from "@/lib/auth/flows/reset-password";
import { signIn } from "@/lib/auth/flows/sign-in";
import { verifyPassword } from "@/lib/auth/password";
import { RATE_LIMITS } from "@/lib/auth/rate-limit";
import { createSession, resolveSession } from "@/lib/auth/sessions";
import { sha256Hex } from "@/lib/auth/tokens";
import { issueTrustedDevice, verifyTrustedDevice } from "@/lib/auth/trusted-device";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { ApiError } from "@/lib/http";
import { lastMail, makeUser, OTHER_PASSWORD, PASSWORD, randomIp, resetTokenIn, uniqueEmail, type SentMail } from "./auth-fixtures";

const mail = vi.hoisted(() => ({ sent: [] as SentMail[] }));
vi.mock("@/lib/email", () => ({
  sendAuthEmail: async (input: SentMail) => {
    mail.sent.push(input);
    return { ok: true };
  },
}));

const T0 = new Date("2026-10-07T06:30:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const ctx = (now: Date = T0) => ({ ip: randomIp(), userAgent: "Vitest", now });

beforeEach(() => {
  mail.sent.length = 0;
});

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

async function forgot(email: string, now: Date = T0) {
  return requestPasswordReset({ email }, ctx(now));
}

async function withSessions(n: number) {
  const made = await makeUser();
  const sessions = [];
  for (let i = 0; i < n; i++) sessions.push(await createSession(db, { userId: made.user.id, kind: "CUSTOMER", now: T0, activeAccountId: made.accountId }));
  return { ...made, sessions };
}

describe("forgot password", () => {
  it("answers the same for unknown addresses and sends nothing", async () => {
    expect(await forgot(uniqueEmail("nobody"))).toEqual({ issued: false });
    expect(mail.sent).toHaveLength(0);
  });

  it("emails a 30-minute link for a real account and stores only the hash of its secret", async () => {
    const { user } = await makeUser();
    expect(await forgot(user.email)).toEqual({ issued: true });
    const token = resetTokenIn(lastMail(mail.sent, user.email, "password_reset"));
    expect(lastMail(mail.sent, user.email, "password_reset").vars.reset_url).toBe(`${getEnv().APP_URL}/reset?token=${encodeURIComponent(token)}`);
    const [id, secret] = token.split(".") as [string, string];
    const row = await db.authToken.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ type: "PASSWORD_RESET", userId: user.id, codeHash: sha256Hex(secret), expiresAt: at(30), usedAt: null });
    expect(JSON.stringify(row)).not.toContain(secret);
  });

  it("does not send links to users who cannot sign in", async () => {
    for (const opts of [{ password: null }, { kind: "STAFF" as const, staffStatus: "DEACTIVATED" as const }, { kind: "STAFF" as const, staffStatus: "INVITED" as const }]) {
      const { user } = await makeUser(opts);
      expect(await forgot(user.email)).toEqual({ issued: false });
    }
    expect(mail.sent).toHaveLength(0);
  });

  it("silently stops after 3 requests per address per hour (still no error)", async () => {
    const { user } = await makeUser();
    for (let i = 0; i < 3; i++) expect(await forgot(user.email, at(i))).toEqual({ issued: true });
    expect(await forgot(user.email, at(3))).toEqual({ issued: false });
    expect(mail.sent).toHaveLength(3);
  });

  it("a throttled request (anyone, from any IP) never voids the live link", async () => {
    const { user } = await makeUser();
    for (let i = 0; i < 3; i++) await forgot(user.email, at(i));
    const live = resetTokenIn(lastMail(mail.sent, user.email, "password_reset"));
    for (let i = 3; i < 6; i++) expect(await forgot(user.email, at(i))).toEqual({ issued: false });
    expect(mail.sent).toHaveLength(3);
    await resetPassword({ token: live, password: OTHER_PASSWORD }, ctx(at(7)));
    expect(await verifyPassword(OTHER_PASSWORD, (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
  });

  it("greets a link-like name as 'there' in the reset email", async () => {
    const { user } = await makeUser({ name: "Your account is on hold. Verify at https://billing.example/secure" });
    await forgot(user.email);
    expect(lastMail(mail.sent, user.email, "password_reset").vars.customer_name).toBe("there");
  });

  it("limits requests per IP with 429", async () => {
    const ip = randomIp();
    for (let i = 0; i < 10; i++) await requestPasswordReset({ email: uniqueEmail("ip") }, { ip, userAgent: null, now: T0 });
    const e = await failure(requestPasswordReset({ email: uniqueEmail("ip") }, { ip, userAgent: null, now: T0 }));
    expect(e).toMatchObject({ status: 429, code: "too_many_attempts" });
  });

  it("supersedes older links with a new request", async () => {
    const { user } = await makeUser();
    await forgot(user.email);
    const first = resetTokenIn(lastMail(mail.sent, user.email, "password_reset"));
    await forgot(user.email, at(1));
    const e = await failure(resetPassword({ token: first, password: OTHER_PASSWORD }, ctx(at(2))));
    expect(e).toMatchObject({ status: 422, code: "token_invalid" });
  });
});

describe("reset password", () => {
  async function linkFor(email: string, now: Date = T0) {
    await forgot(email, now);
    return resetTokenIn(lastMail(mail.sent, email, "password_reset"));
  }

  it("sets the new password, revokes every session and sends the user to sign in", async () => {
    const { user, sessions } = await withSessions(2);
    const token = await linkFor(user.email);
    expect(await inspectResetToken(token, ctx(at(1)))).toEqual({ email: user.email });
    const result = await resetPassword({ token, password: OTHER_PASSWORD }, ctx(at(1)));
    expect(result).toMatchObject({ redirectTo: "/sign-in?reset=1", userId: user.id, revokedSessions: 2 });
    for (const s of sessions) expect(await resolveSession(db, s.token, at(2))).toBeNull();
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await verifyPassword(OTHER_PASSWORD, stored.passwordHash)).toBe(true);
    expect(await verifyPassword(PASSWORD, stored.passwordHash)).toBe(false);
  });

  it("is single use", async () => {
    const { user } = await makeUser();
    const token = await linkFor(user.email);
    await resetPassword({ token, password: OTHER_PASSWORD }, ctx(at(1)));
    const again = await failure(resetPassword({ token, password: "Third3password" }, ctx(at(2))));
    expect(again).toMatchObject({ status: 422, code: "token_invalid", message: "This reset link has already been used. Request a new one." });
  });

  it("expires after 30 minutes", async () => {
    const { user } = await makeUser();
    const token = await linkFor(user.email);
    expect((await failure(inspectResetToken(token, ctx(at(30))))).code).toBe("token_expired");
    const e = await failure(resetPassword({ token, password: OTHER_PASSWORD }, ctx(at(30))));
    expect(e).toMatchObject({ status: 410, code: "token_expired" });
    expect(await verifyPassword(PASSWORD, (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
  });

  it("rejects unknown, tampered and malformed tokens with token_invalid", async () => {
    const { user } = await makeUser();
    const token = await linkFor(user.email);
    const [id] = token.split(".");
    for (const bad of [`${id}.${"A".repeat(43)}`, "nope", `missing.${"B".repeat(43)}`]) {
      expect(await failure(resetPassword({ token: bad, password: OTHER_PASSWORD }, ctx(at(1))))).toMatchObject({ status: 422, code: "token_invalid" });
    }
  });

  it("invalidates trusted devices and lifts the sign-in lock", async () => {
    const { user } = await makeUser({ twoStep: true });
    const secret = getEnv().SESSION_SECRET;
    const device = issueTrustedDevice({ userId: user.id, passwordHash: user.passwordHash, securityEpoch: user.securityEpoch, secret }, T0);
    for (let i = 0; i < 5; i++) await failure(signIn({ email: user.email, password: "Wrong1password" }, ctx()));
    const token = await linkFor(user.email);
    await resetPassword({ token, password: OTHER_PASSWORD }, ctx(at(1)));
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(verifyTrustedDevice(device?.value, { userId: user.id, passwordHash: after.passwordHash, securityEpoch: after.securityEpoch, secret }, at(2))).toBe(false);
    expect(await db.rateLimitBucket.findUnique({ where: { key: RATE_LIMITS.signInEmail(user.email).key } })).toBeNull();
    const result = await signIn({ email: user.email, password: OTHER_PASSWORD }, { ...ctx(at(2)), trustedDevice: device?.value });
    expect(result.requires2fa).toBe(true);
  });
});

describe("change password", () => {
  it("revokes the other sessions but keeps the current one, and logs the change", async () => {
    const { user, accountId, sessions } = await withSessions(3);
    const [current, ...others] = sessions as [(typeof sessions)[number], ...typeof sessions];
    const result = await changePassword({ user, session: current.session }, { current: PASSWORD, next: OTHER_PASSWORD }, { now: at(1) });
    expect(result.revokedSessions).toBe(2);
    expect((await resolveSession(db, current.token, at(2)))?.user.id).toBe(user.id);
    for (const s of others) expect(await resolveSession(db, s.token, at(2))).toBeNull();
    const activity = await db.accountActivity.findMany({ where: { accountId: accountId ?? "" } });
    expect(activity).toEqual([expect.objectContaining({ action: "Changed password", target: "Other sessions signed out", kind: "security", actorId: user.id, actorName: user.name })]);
    expect(await verifyPassword(OTHER_PASSWORD, (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
  });

  it("refuses a wrong current password (422 on the field) and limits checks to 5 per 15 minutes", async () => {
    const { user, sessions } = await withSessions(1);
    const auth = { user, session: sessions[0]!.session };
    for (let i = 0; i < 5; i++) {
      const e = await failure(changePassword(auth, { current: "Wrong1password", next: OTHER_PASSWORD }, { now: T0 }));
      expect(e).toMatchObject({ status: 422, code: "incorrect_password", message: "Your current password is incorrect." });
      expect(e.details).toEqual({ fieldErrors: { current: ["Your current password is incorrect."] }, formErrors: [] });
    }
    const locked = await failure(changePassword(auth, { current: PASSWORD, next: OTHER_PASSWORD }, { now: T0 }));
    expect(locked.status).toBe(429);
    expect(await verifyPassword(PASSWORD, (await db.user.findUniqueOrThrow({ where: { id: user.id } })).passwordHash)).toBe(true);
  });
});

describe("me and sessions", () => {
  it("describes a customer with their active account and team role", async () => {
    const { user, accountId, sessions } = await withSessions(1);
    const me = await getMe({ user, session: sessions[0]!.session });
    expect(me).toEqual({
      user: { id: user.id, name: user.name, email: user.email, kind: "CUSTOMER", emailVerified: true, staffRole: null },
      account: { id: accountId, legalName: `${user.name} Medicals` },
      role: "OWNER",
    });
  });

  it("describes staff without an account", async () => {
    const { user } = await makeUser({ kind: "STAFF" });
    const { session } = await createSession(db, { userId: user.id, kind: "STAFF", now: T0 });
    expect(await getMe({ user, session })).toMatchObject({ user: { kind: "STAFF", staffRole: "SUPPORT" }, account: null, role: null });
  });

  it("lists live sessions with this device first", async () => {
    const { user, sessions } = await withSessions(2);
    const current = sessions[1]!;
    const list = await listMySessions({ user, session: current.session }, at(1));
    expect(list.map((s) => s.id)).toEqual([current.session.id, sessions[0]!.session.id]);
    expect(list[0]).toMatchObject({ current: true });
    expect(JSON.stringify(list)).not.toContain("tokenHash");
  });

  it("signs out all others and logs it", async () => {
    const { user, accountId, sessions } = await withSessions(3);
    const auth = { user, session: sessions[0]!.session };
    expect(await revokeOtherSessions(auth, at(1))).toEqual({ revoked: 2 });
    expect((await listMySessions(auth, at(1))).map((s) => s.id)).toEqual([sessions[0]!.session.id]);
    const activity = await db.accountActivity.findFirstOrThrow({ where: { accountId: accountId ?? "" } });
    expect(activity).toMatchObject({ action: "Signed out all other sessions", kind: "security", actorId: user.id });
  });

  it("signs out one session, and never another user's", async () => {
    const a = await withSessions(2);
    const b = await withSessions(1);
    const auth = { user: a.user, session: a.sessions[0]!.session };
    const e = await failure(revokeMySession(auth, b.sessions[0]!.session.id, at(1)));
    expect(e.status).toBe(404);
    expect(await resolveSession(db, b.sessions[0]!.token, at(1))).not.toBeNull();
    expect(await revokeMySession(auth, a.sessions[1]!.session.id, at(1))).toEqual({ current: false, device: "Unknown device" });
    expect((await failure(revokeMySession(auth, a.sessions[1]!.session.id, at(1)))).status).toBe(404);
    expect(await revokeMySession(auth, a.sessions[0]!.session.id, at(1))).toMatchObject({ current: true });
  });
});
