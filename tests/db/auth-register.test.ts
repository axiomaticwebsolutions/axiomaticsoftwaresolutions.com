import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerUser } from "@/lib/auth/flows/register";
import { resendVerificationCode } from "@/lib/auth/flows/resend-code";
import { verifyEmailCode } from "@/lib/auth/flows/verify-email";
import { RATE_LIMITS } from "@/lib/auth/rate-limit";
import { resolveSession } from "@/lib/auth/sessions";
import { sha256Hex } from "@/lib/auth/tokens";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/http";
import { codeIn, lastMail, makeOrder, PASSWORD, randomIp, uniqueEmail, type SentMail } from "./auth-fixtures";

const mail = vi.hoisted(() => ({ sent: [] as SentMail[] }));
vi.mock("@/lib/email", () => ({
  sendAuthEmail: async (input: SentMail) => {
    mail.sent.push(input);
    return { ok: true };
  },
}));

const T0 = new Date("2026-10-07T06:30:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

beforeEach(() => {
  mail.sent.length = 0;
});

async function register(over: Partial<Parameters<typeof registerUser>[0]> = {}, now = T0) {
  const email = over.email ?? uniqueEmail("priya");
  const result = await registerUser(
    { name: "Priya Sharma", email, password: PASSWORD, businessName: undefined, next: undefined, ...over },
    { ip: randomIp(), userAgent: "Vitest", now },
  );
  const code = codeIn(lastMail(mail.sent, email, "email_verification"));
  return { ...result, email, code };
}

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<ApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({ status, code });
  return error as ApiError;
}

describe("register", () => {
  it("creates an unverified customer, an account they own and a signed-in session on that account", async () => {
    const r = await register({ businessName: "Sharma Medicals" });
    expect(r.user).toMatchObject({ kind: "CUSTOMER", email: r.email, emailVerifiedAt: null, twoStepEnabled: false });
    expect(r.user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(r.account.legalName).toBe("Sharma Medicals");
    const member = await db.accountMember.findFirstOrThrow({ where: { userId: r.user.id } });
    expect(member).toMatchObject({ accountId: r.account.id, role: "OWNER", status: "ACTIVE" });
    expect(r.session.activeAccountId).toBe(r.account.id);
    expect(r.redirectTo).toBe("/verify");
    expect((await resolveSession(db, r.token, at(1)))?.user.id).toBe(r.user.id);
  });

  it("names the account after the person when no business name is given", async () => {
    const r = await register();
    expect(r.account.legalName).toBe("Priya Sharma");
  });

  it("emails a 6-digit code and stores only its keyed hash", async () => {
    const r = await register();
    const token = await db.authToken.findFirstOrThrow({ where: { userId: r.user.id, type: "EMAIL_VERIFY" } });
    expect(token.expiresAt).toEqual(at(15));
    expect(token.codeHash).not.toContain(r.code);
    expect(token.codeHash).not.toBe(sha256Hex(r.code));
    expect(JSON.stringify(token)).not.toContain(r.code);
  });

  it("keeps a safe next for after verification", async () => {
    const r = await register({ next: "/account/software?trial=medical-billing" });
    expect(r.redirectTo).toBe(`/verify?next=${encodeURIComponent("/account/software?trial=medical-billing")}`);
  });

  it("refuses a taken email with 409 email_taken, whatever the case", async () => {
    const r = await register();
    const error = await expectApiError(
      registerUser(
        { name: "Someone", email: r.email, password: PASSWORD, businessName: undefined, next: undefined },
        { ip: randomIp(), userAgent: null, now: T0 },
      ),
      409,
      "email_taken",
    );
    expect(error.message).toBe("An account with this email already exists. Sign in instead.");
  });

  it("limits registrations to 5 per hour per IP", async () => {
    const ip = randomIp();
    for (let i = 0; i < 5; i++) {
      await registerUser({ name: "P", email: uniqueEmail("burst"), password: PASSWORD, businessName: undefined, next: undefined }, { ip, userAgent: null, now: T0 });
    }
    const error = await expectApiError(
      registerUser({ name: "P", email: uniqueEmail("burst"), password: PASSWORD, businessName: undefined, next: undefined }, { ip, userAgent: null, now: T0 }),
      429,
      "too_many_attempts",
    );
    expect(Number(error.headers?.["Retry-After"])).toBeGreaterThan(0);
  });

  it("rotates an existing session instead of keeping it", async () => {
    const first = await register();
    const second = await registerUser(
      { name: "Second", email: uniqueEmail("second"), password: PASSWORD, businessName: undefined, next: undefined },
      { ip: randomIp(), userAgent: null, now: T0, currentSessionId: first.session.id },
    );
    expect(await resolveSession(db, first.token, at(1))).toBeNull();
    expect((await resolveSession(db, second.token, at(1)))?.user.id).toBe(second.user.id);
  });
});

describe("verify email", () => {
  const ctx = (now: Date) => ({ ip: randomIp(), userAgent: "Vitest", now });
  const authOf = async (token: string, now: Date) => {
    const auth = await resolveSession(db, token, now);
    if (!auth) throw new Error("session expected");
    return auth;
  };

  it("links guest orders and their licenses only after verification", async () => {
    const email = uniqueEmail("guest");
    const paid = await makeOrder(email, { withLicense: true });
    const second = await makeOrder(email);
    const someoneElse = await makeOrder(uniqueEmail("other"), { withLicense: true });

    const r = await register({ email });
    // Registered but unverified: nothing moves yet.
    expect((await db.order.findUniqueOrThrow({ where: { id: paid.order.id } })).accountId).toBeNull();
    expect((await db.license.findUniqueOrThrow({ where: { id: paid.licenseId ?? "" } })).accountId).toBeNull();

    const result = await verifyEmailCode(await authOf(r.token, at(2)), { code: r.code, next: undefined }, ctx(at(2)));
    expect(result).toMatchObject({ verified: true, alreadyVerified: false, claimedOrders: 2, claimedLicenses: 1, redirectTo: "/account" });

    expect((await db.user.findUniqueOrThrow({ where: { id: r.user.id } })).emailVerifiedAt).toEqual(at(2));
    for (const id of [paid.order.id, second.order.id]) {
      expect((await db.order.findUniqueOrThrow({ where: { id } })).accountId).toBe(r.account.id);
    }
    expect((await db.license.findUniqueOrThrow({ where: { id: paid.licenseId ?? "" } })).accountId).toBe(r.account.id);
    expect((await db.order.findUniqueOrThrow({ where: { id: someoneElse.order.id } })).accountId).toBeNull();
    expect((await db.license.findUniqueOrThrow({ where: { id: someoneElse.licenseId ?? "" } })).accountId).toBeNull();
  });

  it("rotates the session on verification (privilege change)", async () => {
    const r = await register();
    const result = await verifyEmailCode(await authOf(r.token, at(1)), { code: r.code }, ctx(at(1)));
    expect(result.session).not.toBeNull();
    expect(await resolveSession(db, r.token, at(2))).toBeNull();
    const fresh = await resolveSession(db, result.session?.token, at(2));
    expect(fresh?.user.id).toBe(r.user.id);
    expect(fresh?.session.activeAccountId).toBe(r.account.id);
  });

  it("continues to the next stored at registration", async () => {
    const r = await register({ next: "/account/software?trial=medical-billing" });
    const result = await verifyEmailCode(await authOf(r.token, at(1)), { code: r.code }, ctx(at(1)));
    expect(result.redirectTo).toBe("/account/software?trial=medical-billing");
  });

  it("rejects a wrong code, then uses the code up after 5 guesses (even the right one)", async () => {
    const r = await register();
    const auth = await authOf(r.token, at(1));
    const wrong = r.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const error = await expectApiError(verifyEmailCode(auth, { code: wrong }, ctx(at(1))), 422, "invalid_code");
      expect(error.message).toBe("That code is not correct. Check the latest email we sent.");
    }
    const locked = await expectApiError(verifyEmailCode(auth, { code: r.code }, ctx(at(1))), 429, "too_many_attempts");
    expect(locked.message).toBe("Too many attempts. Request a new code.");
    expect(Number(locked.headers?.["Retry-After"])).toBeGreaterThanOrEqual(1);
    expect((await db.user.findUniqueOrThrow({ where: { id: r.user.id } })).emailVerifiedAt).toBeNull();
  });

  it("caps wrong guesses at 10 per user per 24 hours across codes: the 11th answers 429 with the wait", async () => {
    const r = await register();
    const auth = await authOf(r.token, at(1));
    const wrongFor = (code: string) => (code === "000000" ? "111111" : "000000");
    let code = r.code;
    for (let i = 0; i < 10; i++) {
      if (i === 5) {
        // The first code is used up after 5 guesses: a resend hands out a fresh one.
        await resendVerificationCode(r.user, { now: at(2) });
        code = codeIn(lastMail(mail.sent, r.email, "email_verification"));
      }
      await expectApiError(verifyEmailCode(auth, { code: wrongFor(code) }, ctx(at(3))), 422, "invalid_code");
    }
    await resendVerificationCode(r.user, { now: at(20) });
    code = codeIn(lastMail(mail.sent, r.email, "email_verification"));
    const locked = await expectApiError(verifyEmailCode(auth, { code }, ctx(at(21))), 429, "too_many_attempts");
    expect(locked.message).toMatch(/^Too many attempts\. Try again in (2[0-4]) hours\.$/);
    expect(Number(locked.headers?.["Retry-After"])).toBeGreaterThan(20 * 3600);
    // The right code still works once the day is over.
    await resendVerificationCode(r.user, { now: at(24 * 60 + 5) });
    code = codeIn(lastMail(mail.sent, r.email, "email_verification"));
    expect((await verifyEmailCode(auth, { code }, ctx(at(24 * 60 + 6)))).verified).toBe(true);
  });

  it("caps guesses per IP at 30 per 15 minutes across users, and a used-up code does not count against the caps", async () => {
    const ip = randomIp();
    const ctxAt = (from: string) => ({ ip: from, userAgent: "Vitest", now: at(2) });
    let usedUp: { auth: Awaited<ReturnType<typeof authOf>>; code: string } | null = null;
    for (let user = 0; user < 6; user++) {
      const r = await register();
      const auth = await authOf(r.token, at(1));
      const wrong = r.code === "000000" ? "111111" : "000000";
      for (let i = 0; i < 5; i++) await expectApiError(verifyEmailCode(auth, { code: wrong }, ctxAt(ip)), 422, "invalid_code");
      usedUp = { auth, code: r.code };
    }
    // 30 wrong guesses from this IP: even a right code is refused from it.
    const fresh = await register();
    const freshAuth = await authOf(fresh.token, at(1));
    const blocked = await expectApiError(verifyEmailCode(freshAuth, { code: fresh.code }, ctxAt(ip)), 429, "too_many_attempts");
    expect(blocked.message).toMatch(/^Too many attempts\. Try again in \d+ minutes?\.$/);
    expect((await verifyEmailCode(freshAuth, { code: fresh.code }, ctxAt(randomIp()))).verified).toBe(true);

    // A code used up by 5 guesses answers "Request a new code." and takes no slot from the new IP.
    const other = randomIp();
    const usedUpError = await expectApiError(verifyEmailCode(usedUp!.auth, { code: usedUp!.code }, ctxAt(other)), 429, "too_many_attempts");
    expect(usedUpError.message).toBe("Too many attempts. Request a new code.");
    expect(await db.rateLimitBucket.findUnique({ where: { key: RATE_LIMITS.verifyEmailIp(other).key } })).toMatchObject({ count: 0 });
  });

  it("greets link-like names as 'there' in the verification email", async () => {
    const r = await register({ name: "Your account is on hold. Verify at https://billing.example/secure" });
    expect(lastMail(mail.sent, r.email, "email_verification").vars.customer_name).toBe("there");
  });

  it("expires the code after 15 minutes", async () => {
    const r = await register();
    const auth = await authOf(r.token, at(1));
    await expectApiError(verifyEmailCode(auth, { code: r.code }, ctx(at(15))), 410, "code_expired");
  });

  it("only accepts the latest code after a resend", async () => {
    const r = await register();
    await resendVerificationCode(r.user, { now: at(1) });
    const newCode = codeIn(lastMail(mail.sent, r.email, "email_verification"));
    const auth = await authOf(r.token, at(2));
    if (newCode !== r.code) await expectApiError(verifyEmailCode(auth, { code: r.code }, ctx(at(2))), 422, "invalid_code");
    const result = await verifyEmailCode(auth, { code: newCode }, ctx(at(2)));
    expect(result.verified).toBe(true);
  });

  it("is a no-op for an already verified user", async () => {
    const r = await register();
    const first = await verifyEmailCode(await authOf(r.token, at(1)), { code: r.code }, ctx(at(1)));
    const again = await verifyEmailCode(await authOf(first.session?.token ?? "", at(2)), { code: "999999" }, ctx(at(2)));
    expect(again).toMatchObject({ verified: true, alreadyVerified: true, claimedOrders: 0, session: null });
  });
});

describe("resend code", () => {
  it("allows 3 resends per 15 minutes, then 429 with Retry-After", async () => {
    const r = await register();
    for (let i = 0; i < 3; i++) expect(await resendVerificationCode(r.user, { now: at(i) })).toEqual({ sent: true });
    const error = await expectApiError(resendVerificationCode(r.user, { now: at(3) }), 429, "too_many_attempts");
    expect(Number(error.headers?.["Retry-After"])).toBeGreaterThan(0);
    expect(await resendVerificationCode(r.user, { now: at(16) })).toEqual({ sent: true });
  });

  it("does nothing for verified users", async () => {
    const r = await register();
    const verified = await db.user.update({ where: { id: r.user.id }, data: { emailVerifiedAt: T0 } });
    mail.sent.length = 0;
    expect(await resendVerificationCode(verified, { now: at(1) })).toEqual({ sent: false });
    expect(mail.sent).toHaveLength(0);
  });
});
