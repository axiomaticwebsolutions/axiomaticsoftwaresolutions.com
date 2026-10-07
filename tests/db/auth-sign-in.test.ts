import { beforeEach, describe, expect, it, vi } from "vitest";
import { verifyLoginCode } from "@/lib/auth/flows/login-code";
import { signIn, type SignInContext } from "@/lib/auth/flows/sign-in";
import { signOut } from "@/lib/auth/flows/sign-out";
import * as passwordModule from "@/lib/auth/password";
import { RATE_LIMITS } from "@/lib/auth/rate-limit";
import { createSession, resolveSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { codeIn, lastMail, makeOrder, makeUser, PASSWORD, randomIp, uniqueEmail, type SentMail } from "./auth-fixtures";

const mail = vi.hoisted(() => ({ sent: [] as SentMail[] }));
vi.mock("@/lib/email", () => ({
  sendAuthEmail: async (input: SentMail) => {
    mail.sent.push(input);
    return { ok: true };
  },
}));
vi.mock("@/lib/auth/password", async (importOriginal) => {
  const actual = await importOriginal<typeof passwordModule>();
  return { ...actual, verifyAgainstDummy: vi.fn(actual.verifyAgainstDummy), verifyPassword: vi.fn(actual.verifyPassword) };
});

const T0 = new Date("2026-10-07T06:30:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

beforeEach(() => {
  mail.sent.length = 0;
  vi.mocked(passwordModule.verifyAgainstDummy).mockClear();
  vi.mocked(passwordModule.verifyPassword).mockClear();
});

const ctx = (over: Partial<SignInContext> = {}): SignInContext => ({ ip: randomIp(), userAgent: "Vitest", now: T0, ...over });

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

async function signedIn(email: string, password: string, c: SignInContext = ctx()) {
  const result = await signIn({ email, password, next: undefined }, c);
  if (result.requires2fa) throw new Error("unexpected two-step challenge");
  return result;
}

describe("password sign-in", () => {
  it("signs a verified customer in to the portal with a fresh session on their account", async () => {
    const { user, accountId } = await makeUser();
    const result = await signedIn(user.email, PASSWORD);
    expect(result.redirectTo).toBe("/account");
    expect(result.session.activeAccountId).toBe(accountId);
    expect((await resolveSession(db, result.token, at(1)))?.user.id).toBe(user.id);
  });

  it("sends staff to the console and unverified customers to /verify", async () => {
    const staff = await makeUser({ kind: "STAFF" });
    expect((await signedIn(staff.user.email, PASSWORD)).redirectTo).toBe("/admin");
    const unverified = await makeUser({ verified: false });
    const r = await signIn({ email: unverified.user.email, password: PASSWORD, next: "/checkout" }, ctx());
    expect(r.requires2fa === false && r.redirectTo).toBe(`/verify?next=${encodeURIComponent("/checkout")}`);
  });

  it("gives the same error for an unknown email and a wrong password, after the same argon2 work", async () => {
    const { user } = await makeUser();
    const unknown = await failure(signIn({ email: uniqueEmail("nobody"), password: PASSWORD }, ctx()));
    expect(passwordModule.verifyAgainstDummy).toHaveBeenCalledTimes(1);
    const wrong = await failure(signIn({ email: user.email, password: "Wrong1password" }, ctx()));
    expect(passwordModule.verifyPassword).toHaveBeenCalledTimes(1);
    expect(unknown).toMatchObject({ status: 401, code: "invalid_credentials", message: "Email or password is incorrect." });
    expect(wrong).toMatchObject({ status: 401, code: "invalid_credentials", message: unknown.message });
    expect(wrong.details).toEqual(unknown.details);
  });

  it("takes comparable time for unknown emails and wrong passwords", async () => {
    const { user } = await makeUser();
    const time = async (email: string) => {
      const started = performance.now();
      await failure(signIn({ email, password: "Wrong1password" }, ctx()));
      return performance.now() - started;
    };
    await time(uniqueEmail("warmup"));
    const unknown: number[] = [];
    const known: number[] = [];
    for (let i = 0; i < 3; i++) {
      unknown.push(await time(uniqueEmail("nobody")));
      known.push(await time(user.email));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[1] ?? 0;
    const ratio = median(unknown) / median(known);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(2.5);
  });

  it("locks the email after 5 failures: the 6th attempt is 429 with Retry-After, even with the right password", async () => {
    const { user } = await makeUser();
    const messages: string[] = [];
    for (let i = 0; i < 5; i++) {
      const e = await failure(signIn({ email: user.email, password: "Wrong1password" }, ctx({ now: at(i) })));
      expect(e.status).toBe(401);
      messages.push(e.message);
    }
    expect(messages).toEqual([
      "Email or password is incorrect.",
      "Email or password is incorrect.",
      "Email or password is incorrect. 2 attempts left.",
      "Email or password is incorrect. 1 attempt left.",
      "Email or password is incorrect.",
    ]);
    const locked = await failure(signIn({ email: user.email, password: PASSWORD }, ctx({ now: at(5) })));
    expect(locked).toMatchObject({ status: 429, code: "too_many_attempts" });
    expect(locked.message).toBe("Too many attempts. Try again in 10 minutes, or reset your password.");
    expect(locked.headers?.["Retry-After"]).toBe("600");
    // The window started with the first failure (T0) and lasts 15 minutes.
    expect((await signedIn(user.email, PASSWORD, ctx({ now: at(15) }))).user.id).toBe(user.id);
  });

  it("counts unknown emails the same way (the attempts-left hint reveals nothing)", async () => {
    const email = uniqueEmail("ghost");
    const messages: string[] = [];
    for (let i = 0; i < 5; i++) messages.push((await failure(signIn({ email, password: "Wrong1password" }, ctx()))).message);
    expect(messages[2]).toBe("Email or password is incorrect. 2 attempts left.");
    expect((await failure(signIn({ email, password: "Wrong1password" }, ctx()))).status).toBe(429);
  });
});

describe("sign-in limits, staff and sessions", () => {
  it("clears the per-email count after a success", async () => {
    const { user } = await makeUser();
    for (let i = 0; i < 4; i++) await failure(signIn({ email: user.email, password: "Wrong1password" }, ctx()));
    await signedIn(user.email, PASSWORD);
    expect(await db.rateLimitBucket.findUnique({ where: { key: RATE_LIMITS.signInEmail(user.email).key } })).toBeNull();
    const e = await failure(signIn({ email: user.email, password: "Wrong1password" }, ctx()));
    expect(e.message).toBe("Email or password is incorrect.");
  });

  it("also limits per IP (20 / 15 min) and refunds the IP slot on success", async () => {
    const ip = randomIp();
    const { user } = await makeUser();
    for (let i = 0; i < 3; i++) await signedIn(user.email, PASSWORD, ctx({ ip }));
    const bucket = await db.rateLimitBucket.findUnique({ where: { key: RATE_LIMITS.signInIp(ip).key } });
    expect(bucket?.count ?? 0).toBe(0);
    for (let i = 0; i < 20; i++) await failure(signIn({ email: uniqueEmail(`spray${i}`), password: "x" }, ctx({ ip })));
    const e = await failure(signIn({ email: user.email, password: PASSWORD }, ctx({ ip })));
    expect(e.status).toBe(429);
    // The refused attempt was not counted against the email (its slot was given back).
    const emailBucket = await db.rateLimitBucket.findUnique({ where: { key: RATE_LIMITS.signInEmail(user.email).key } });
    expect(emailBucket?.count ?? 0).toBe(0);
  });

  it("refuses deactivated and invited staff with the generic error, even with the right password", async () => {
    for (const staffStatus of ["DEACTIVATED", "INVITED"] as const) {
      const { user } = await makeUser({ kind: "STAFF", staffStatus });
      const e = await failure(signIn({ email: user.email, password: PASSWORD }, ctx()));
      expect(e).toMatchObject({ status: 401, code: "invalid_credentials", message: "Email or password is incorrect." });
    }
  });

  it("refuses users without a password (sample users) with the generic error", async () => {
    const { user } = await makeUser({ password: null });
    expect((await failure(signIn({ email: user.email, password: PASSWORD }, ctx()))).code).toBe("invalid_credentials");
  });

  it("rotates the existing session, and sign-out invalidates the DB session", async () => {
    const { user } = await makeUser();
    const planted = await createSession(db, { userId: user.id, kind: "CUSTOMER", now: T0 });
    const result = await signedIn(user.email, PASSWORD, ctx({ currentSessionId: planted.session.id }));
    expect(await resolveSession(db, planted.token, at(1))).toBeNull();
    expect(await signOut(result.session.id, at(1))).toBe(true);
    expect(await resolveSession(db, result.token, at(2))).toBeNull();
    expect((await db.session.findUniqueOrThrow({ where: { id: result.session.id } })).revokedAt).toEqual(at(1));
  });

  it("claims guest orders on every sign-in of a verified customer", async () => {
    const { user, accountId } = await makeUser();
    const guest = await makeOrder(user.email, { withLicense: true });
    await signedIn(user.email, PASSWORD);
    expect((await db.order.findUniqueOrThrow({ where: { id: guest.order.id } })).accountId).toBe(accountId);
    expect((await db.license.findUniqueOrThrow({ where: { id: guest.licenseId ?? "" } })).accountId).toBe(accountId);
    const later = await makeOrder(user.email);
    await signedIn(user.email, PASSWORD);
    expect((await db.order.findUniqueOrThrow({ where: { id: later.order.id } })).accountId).toBe(accountId);
  });

  it("does not claim for unverified customers", async () => {
    const { user } = await makeUser({ verified: false });
    const guest = await makeOrder(user.email);
    await signIn({ email: user.email, password: PASSWORD }, ctx());
    expect((await db.order.findUniqueOrThrow({ where: { id: guest.order.id } })).accountId).toBeNull();
  });
});

describe("two-step sign-in", () => {
  async function challenge(email: string, c: SignInContext = ctx(), next?: string) {
    const result = await signIn({ email, password: PASSWORD, next }, c);
    if (!result.requires2fa) throw new Error("expected a challenge");
    return { ...result, code: codeIn(lastMail(mail.sent, email, "login_code")) };
  }

  it("asks for an emailed code instead of creating a session", async () => {
    const { user } = await makeUser({ twoStep: true });
    const sessionsBefore = await db.session.count({ where: { userId: user.id } });
    const c = await challenge(user.email);
    expect(c.emailHint).toBe(`c•••@${user.email.split("@")[1]}`);
    expect(c.challengeId).toMatch(/^[a-z0-9]+\.[A-Za-z0-9_-]{43}$/);
    expect(await db.session.count({ where: { userId: user.id } })).toBe(sessionsBefore);
    const row = await db.authToken.findFirstOrThrow({ where: { userId: user.id, type: "LOGIN_OTP" } });
    expect(row.expiresAt).toEqual(at(10));
    expect(JSON.stringify(row)).not.toContain(c.code);
    expect(JSON.stringify(row)).not.toContain(c.challengeId.split(".")[1]);
  });

  it("completes with the right code: session, next, cleared counters", async () => {
    const { user } = await makeUser({ kind: "STAFF", twoStep: true });
    const c = await challenge(user.email, ctx(), "/admin/orders");
    const done = await verifyLoginCode({ challengeId: c.challengeId, code: c.code, trustDevice: false }, ctx({ now: at(1) }));
    expect(done.redirectTo).toBe("/admin/orders");
    expect(done.trustedDevice).toBeNull();
    expect((await resolveSession(db, done.token, at(2)))?.user.id).toBe(user.id);
    expect(await db.rateLimitBucket.findUnique({ where: { key: RATE_LIMITS.signInEmail(user.email).key } })).toBeNull();
    // Single use.
    const again = await failure(verifyLoginCode({ challengeId: c.challengeId, code: c.code, trustDevice: false }, ctx({ now: at(1) })));
    expect(again).toMatchObject({ status: 410, code: "code_expired" });
  });

  it("rejects wrong codes, then uses the challenge up after 5 (429, even for the right code)", async () => {
    const { user } = await makeUser({ twoStep: true });
    const c = await challenge(user.email);
    const wrong = c.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const e = await failure(verifyLoginCode({ challengeId: c.challengeId, code: wrong, trustDevice: false }, ctx()));
      expect(e).toMatchObject({ status: 422, code: "invalid_code", message: "That code is not correct. Check the latest email we sent." });
    }
    const locked = await failure(verifyLoginCode({ challengeId: c.challengeId, code: c.code, trustDevice: false }, ctx()));
    expect(locked).toMatchObject({ status: 429, code: "too_many_attempts", message: "Too many attempts. Sign in again to get a new code." });
    expect(Number(locked.headers?.["Retry-After"])).toBeGreaterThanOrEqual(1);
  });

  it("expires after 10 minutes, and a forged or foreign challenge id is refused", async () => {
    const { user } = await makeUser({ twoStep: true });
    const c = await challenge(user.email);
    const late = await failure(verifyLoginCode({ challengeId: c.challengeId, code: c.code, trustDevice: false }, ctx({ now: at(10) })));
    expect(late).toMatchObject({ status: 410, code: "code_expired" });
    const fresh = await challenge(user.email);
    const [id] = fresh.challengeId.split(".");
    const forged = await failure(verifyLoginCode({ challengeId: `${id}.${"A".repeat(43)}`, code: fresh.code, trustDevice: false }, ctx()));
    expect(forged.status).toBe(410);
    expect((await failure(verifyLoginCode({ challengeId: "junk", code: fresh.code, trustDevice: false }, ctx()))).status).toBe(410);
  });

  it("only the latest challenge works", async () => {
    const { user } = await makeUser({ twoStep: true });
    const first = await challenge(user.email);
    const second = await challenge(user.email);
    expect((await failure(verifyLoginCode({ challengeId: first.challengeId, code: first.code, trustDevice: false }, ctx()))).status).toBe(410);
    const done = await verifyLoginCode({ challengeId: second.challengeId, code: second.code, trustDevice: false }, ctx());
    expect(done.user.id).toBe(user.id);
  });
});

describe("trusted devices", () => {
  async function trustedSignIn(email: string) {
    const first = await signIn({ email, password: PASSWORD }, ctx());
    if (!first.requires2fa) throw new Error("expected a challenge");
    const code = codeIn(lastMail(mail.sent, email, "login_code"));
    const done = await verifyLoginCode({ challengeId: first.challengeId, code, trustDevice: true }, ctx());
    if (!done.trustedDevice) throw new Error("expected a trusted-device cookie");
    return done.trustedDevice;
  }

  it("skips the code on a trusted device for 30 days", async () => {
    const { user } = await makeUser({ twoStep: true });
    const device = await trustedSignIn(user.email);
    expect(device.expiresAt.getTime()).toBeGreaterThan(at(29 * 24 * 60).getTime());
    mail.sent.length = 0;
    const result = await signIn({ email: user.email, password: PASSWORD }, ctx({ now: at(29 * 24 * 60), trustedDevice: device.value }));
    expect(result.requires2fa).toBe(false);
    expect(mail.sent).toHaveLength(0);
  });

  it("still requires the password on a trusted device", async () => {
    const { user } = await makeUser({ twoStep: true });
    const device = await trustedSignIn(user.email);
    const e = await failure(signIn({ email: user.email, password: "Wrong1password" }, ctx({ now: at(29 * 24 * 60), trustedDevice: device.value })));
    expect(e.code).toBe("invalid_credentials");
  });

  it("does not carry over to another user, and stops working after a password change", async () => {
    const a = await makeUser({ twoStep: true });
    const b = await makeUser({ twoStep: true });
    const device = await trustedSignIn(a.user.email);
    const other = await signIn({ email: b.user.email, password: PASSWORD }, ctx({ now: at(29 * 24 * 60), trustedDevice: device.value }));
    expect(other.requires2fa).toBe(true);

    await db.user.update({ where: { id: a.user.id }, data: { passwordHash: await passwordModule.hashPassword(PASSWORD) } });
    const after = await signIn({ email: a.user.email, password: PASSWORD }, ctx({ now: at(29 * 24 * 60), trustedDevice: device.value }));
    expect(after.requires2fa).toBe(true);
  });

  it("refuses staff deactivated between the password and the code", async () => {
    const { user } = await makeUser({ kind: "STAFF", twoStep: true });
    const c = await signIn({ email: user.email, password: PASSWORD }, ctx());
    if (!c.requires2fa) throw new Error("expected a challenge");
    const code = codeIn(lastMail(mail.sent, user.email, "login_code"));
    await db.user.update({ where: { id: user.id }, data: { staffStatus: "DEACTIVATED" } });
    const e = await failure(verifyLoginCode({ challengeId: c.challengeId, code, trustDevice: true }, ctx()));
    expect(e).toMatchObject({ status: 401, code: "invalid_credentials" });
    expect(await db.session.count({ where: { userId: user.id, revokedAt: null } })).toBe(0);
  });
});
