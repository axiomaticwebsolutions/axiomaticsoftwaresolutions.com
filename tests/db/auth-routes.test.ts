/**
 * The auth route handlers end to end (CSRF, cookies, status codes, headers), with next/headers' cookie store
 * replaced by an in-memory jar that behaves like the browser.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as forgotPOST } from "@/app/api/auth/forgot-password/route";
import { POST as registerPOST } from "@/app/api/auth/register/route";
import { GET as resetGET, POST as resetPOST } from "@/app/api/auth/reset-password/route";
import { POST as signInPOST } from "@/app/api/auth/sign-in/route";
import { POST as signInVerifyPOST } from "@/app/api/auth/sign-in/verify/route";
import { POST as signOutPOST } from "@/app/api/auth/sign-out/route";
import { POST as verifyEmailPOST } from "@/app/api/auth/verify-email/route";
import { GET as meGET } from "@/app/api/me/route";
import { POST as passwordPOST } from "@/app/api/me/password/route";
import { DELETE as sessionsDELETE, GET as sessionsGET } from "@/app/api/me/sessions/route";
import { DELETE as sessionDELETE } from "@/app/api/me/sessions/[id]/route";
import { ANON_CSRF_BINDING, issueCsrfToken } from "@/lib/auth/csrf";
import { resolveSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { getEnv, resetEnvCache } from "@/lib/env";
import { codeIn, lastMail, makeUser, OTHER_PASSWORD, PASSWORD, resetTokenIn, uniqueEmail, type SentMail } from "./auth-fixtures";

type CookieSet = { name: string; value: string; options: Record<string, unknown> };
const jar = vi.hoisted(() => ({ cookies: new Map<string, string>(), sets: [] as CookieSet[] }));
const mail = vi.hoisted(() => ({ sent: [] as SentMail[] }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.cookies.has(name) ? { name, value: jar.cookies.get(name) } : undefined),
    set: (name: string, value: string, options: Record<string, unknown> = {}) => {
      jar.sets.push({ name, value, options });
      if (options.maxAge === 0 || value === "") jar.cookies.delete(name);
      else jar.cookies.set(name, value);
    },
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/email", () => ({
  sendAuthEmail: async (input: SentMail) => {
    mail.sent.push(input);
    return { ok: true };
  },
}));

type Handler = (req: NextRequest, ctx: never) => Promise<Response>;
type CallOptions = { method?: string; body?: unknown; csrf?: boolean; origin?: string; ctx?: unknown };

function appUrl(): string {
  return getEnv().APP_URL;
}

async function call(handler: Handler, path: string, opts: CallOptions = {}): Promise<Response> {
  const headers = new Headers({ origin: opts.origin ?? new URL(appUrl()).origin, "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/129.0 Safari/537.36" });
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  const cookie = [...jar.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookie) headers.set("cookie", cookie);
  const csrf = jar.cookies.get("axs_csrf");
  if (opts.csrf !== false && csrf) headers.set("x-csrf-token", csrf);
  const req = new NextRequest(`${appUrl()}${path}`, {
    method: opts.method ?? "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return handler(req, (opts.ctx ?? {}) as never);
}

const bodyOf = async (res: Response) => (await res.json()) as Record<string, unknown>;
const lastSet = (name: string) => [...jar.sets].reverse().find((s) => s.name === name);

function freshBrowser() {
  jar.cookies.clear();
  jar.sets.length = 0;
  jar.cookies.set("axs_csrf", issueCsrfToken(ANON_CSRF_BINDING, getEnv().CSRF_SECRET));
}

beforeEach(async () => {
  freshBrowser();
  mail.sent.length = 0;
  // Route calls have no trusted client IP (TRUSTED_PROXY_HOPS=0), so they share the "unknown" IP buckets.
  await db.rateLimitBucket.deleteMany({});
});

async function signInAs(email: string, password = PASSWORD) {
  const res = await call(signInPOST as Handler, "/api/auth/sign-in", { body: { email, password } });
  expect(res.status).toBe(200);
  return bodyOf(res);
}

describe("register and verify routes", () => {
  it("registers, sets an httpOnly SameSite=Lax session cookie and a new CSRF token, then verifies", async () => {
    const email = uniqueEmail("route");
    const res = await call(registerPOST as Handler, "/api/auth/register", {
      body: { name: "Priya Sharma", email, password: PASSWORD, businessName: "Sharma Medicals" },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await bodyOf(res);
    expect(body).toEqual({ user: { id: expect.any(String), name: "Priya Sharma", email, emailVerified: false }, redirectTo: "/verify" });

    const session = lastSet("axs_session");
    expect(session?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure: false });
    expect(session?.options.expires).toBeInstanceOf(Date);
    const csrf = lastSet("axs_csrf");
    expect(csrf?.options).toMatchObject({ httpOnly: false, sameSite: "lax", path: "/" });
    const auth = await resolveSession(db, session?.value);
    expect(auth?.user.email).toBe(email);

    const code = codeIn(lastMail(mail.sent, email, "email_verification"));
    const verified = await call(verifyEmailPOST as Handler, "/api/auth/verify-email", { body: { code } });
    expect(verified.status).toBe(200);
    expect(await bodyOf(verified)).toEqual({ verified: true, claimedOrders: 0, redirectTo: "/account" });
    // Rotated: the registration session is gone, the new cookie works.
    expect(await resolveSession(db, session?.value)).toBeNull();
    expect((await resolveSession(db, jar.cookies.get("axs_session")))?.user.emailVerifiedAt).not.toBeNull();
  });

  it("answers 409 email_taken with the prototype copy", async () => {
    const { user } = await makeUser();
    const res = await call(registerPOST as Handler, "/api/auth/register", { body: { name: "X", email: user.email, password: PASSWORD } });
    expect(res.status).toBe(409);
    expect(await bodyOf(res)).toEqual({ error: { code: "email_taken", message: "An account with this email already exists. Sign in instead." } });
  });

  it("rejects unknown keys and bad fields with 422 and field errors", async () => {
    const res = await call(registerPOST as Handler, "/api/auth/register", { body: { name: "", email: "x", password: "short", admin: true } });
    expect(res.status).toBe(422);
    const { error } = (await bodyOf(res)) as { error: { code: string; fieldErrors: Record<string, string[]> } };
    expect(error.code).toBe("validation_failed");
    expect(Object.keys(error.fieldErrors).sort()).toEqual(["admin", "email", "name", "password"]);
  });

  it("refuses requests without the CSRF token or from another site", async () => {
    const noToken = await call(registerPOST as Handler, "/api/auth/register", { body: { name: "X", email: uniqueEmail("x"), password: PASSWORD }, csrf: false });
    expect(noToken.status).toBe(403);
    expect(((await bodyOf(noToken)).error as { code: string }).code).toBe("csrf_failed");
    const crossSite = await call(signInPOST as Handler, "/api/auth/sign-in", { body: { email: "a@b.example", password: "x" }, origin: "https://evil.example" });
    expect(crossSite.status).toBe(403);
  });

  it("asks signed-out callers of verify-email to sign in again", async () => {
    const res = await call(verifyEmailPOST as Handler, "/api/auth/verify-email", { body: { code: "123456" } });
    expect(res.status).toBe(401);
    expect(await bodyOf(res)).toEqual({ error: { code: "unauthorized", message: "Sign in again to verify your email." } });
  });
});

describe("sign-in and sign-out routes", () => {
  it("returns byte-identical 401 bodies for an unknown email and a wrong password", async () => {
    const { user } = await makeUser();
    const unknown = await call(signInPOST as Handler, "/api/auth/sign-in", { body: { email: uniqueEmail("nobody"), password: PASSWORD } });
    const wrong = await call(signInPOST as Handler, "/api/auth/sign-in", { body: { email: user.email, password: "Wrong1password" } });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
  });

  it("answers the 6th attempt with 429 and a Retry-After header, even with the right password", async () => {
    const { user } = await makeUser();
    for (let i = 0; i < 5; i++) {
      expect((await call(signInPOST as Handler, "/api/auth/sign-in", { body: { email: user.email, password: "Wrong1password" } })).status).toBe(401);
    }
    const res = await call(signInPOST as Handler, "/api/auth/sign-in", { body: { email: user.email, password: PASSWORD } });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(800);
    const { error } = (await bodyOf(res)) as { error: { code: string; message: string; retryAfterSec: number } };
    expect(error.code).toBe("too_many_attempts");
    expect(error.message).toMatch(/^Too many attempts\. Try again in 15 minutes, or reset your password\.$/);
    expect(jar.cookies.has("axs_session")).toBe(false);
  });

  it("signs in, exposes /api/me, and sign-out invalidates the DB session and clears the cookie", async () => {
    const { user, accountId } = await makeUser();
    expect((await call(meGET as Handler, "/api/me", { method: "GET" })).status).toBe(401);
    expect(await signInAs(user.email)).toEqual({ requires2fa: false, redirectTo: "/account" });
    const token = jar.cookies.get("axs_session");
    const me = await call(meGET as Handler, "/api/me", { method: "GET" });
    expect(me.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(me)).toMatchObject({ user: { id: user.id, emailVerified: true }, account: { id: accountId }, role: "OWNER" });

    const out = await call(signOutPOST as Handler, "/api/auth/sign-out");
    expect(out.status).toBe(204);
    expect(lastSet("axs_session")?.options).toMatchObject({ maxAge: 0, httpOnly: true });
    expect(jar.cookies.has("axs_session")).toBe(false);
    expect(await resolveSession(db, token)).toBeNull();
    // A replayed cookie no longer works.
    jar.cookies.set("axs_session", token ?? "");
    expect((await call(meGET as Handler, "/api/me", { method: "GET" })).status).toBe(401);
  });

  it("marks cookies Secure when the site is served over https", async () => {
    const previous = process.env.APP_URL;
    process.env.APP_URL = "https://shop.example.test";
    resetEnvCache();
    try {
      freshBrowser();
      const { user } = await makeUser();
      await signInAs(user.email);
      expect(lastSet("axs_session")?.options).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax" });
      expect(lastSet("axs_csrf")?.options).toMatchObject({ secure: true });
    } finally {
      process.env.APP_URL = previous;
      resetEnvCache();
    }
  });

  it("runs two-step sign-in through the routes and remembers a trusted device", async () => {
    const { user } = await makeUser({ kind: "STAFF", twoStep: true });
    const first = await signInAs(user.email);
    expect(first).toMatchObject({ requires2fa: true, emailHint: expect.stringContaining("•••@") });
    expect(jar.cookies.has("axs_session")).toBe(false);
    const code = codeIn(lastMail(mail.sent, user.email, "login_code"));
    const res = await call(signInVerifyPOST as Handler, "/api/auth/sign-in/verify", { body: { challengeId: first.challengeId, code, trustDevice: true } });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ redirectTo: "/admin" });
    expect(lastSet("axs_td")?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/api/auth" });

    await call(signOutPOST as Handler, "/api/auth/sign-out");
    expect(await signInAs(user.email)).toEqual({ requires2fa: false, redirectTo: "/admin" });
  });
});

describe("password routes", () => {
  it("forgot-password answers 200 {} for unknown and known addresses alike", async () => {
    const { user } = await makeUser();
    const unknown = await call(forgotPOST as Handler, "/api/auth/forgot-password", { body: { email: uniqueEmail("nobody") } });
    const known = await call(forgotPOST as Handler, "/api/auth/forgot-password", { body: { email: user.email } });
    expect([unknown.status, known.status]).toEqual([200, 200]);
    expect(await unknown.text()).toBe(await known.text());
    expect(mail.sent.map((m) => m.to)).toEqual([user.email]);
  });

  it("reset-password: GET shows the account, POST resets, revokes the caller's session and points to sign-in", async () => {
    const { user } = await makeUser();
    await signInAs(user.email);
    const token = jar.cookies.get("axs_session");
    await call(forgotPOST as Handler, "/api/auth/forgot-password", { body: { email: user.email } });
    const resetToken = resetTokenIn(lastMail(mail.sent, user.email, "password_reset"));

    const peek = await call(resetGET as Handler, `/api/auth/reset-password?token=${encodeURIComponent(resetToken)}`, { method: "GET" });
    expect(await bodyOf(peek)).toEqual({ email: user.email, mode: "reset" });

    const res = await call(resetPOST as Handler, "/api/auth/reset-password", { body: { token: resetToken, password: OTHER_PASSWORD } });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ redirectTo: "/sign-in?reset=1" });
    expect(await resolveSession(db, token)).toBeNull();
    expect(jar.cookies.has("axs_session")).toBe(false);

    const reused = await call(resetPOST as Handler, "/api/auth/reset-password", { body: { token: resetToken, password: "Third3password" } });
    expect(reused.status).toBe(422);
    expect(((await bodyOf(reused)).error as { code: string }).code).toBe("token_invalid");
    const badPeek = await call(resetGET as Handler, "/api/auth/reset-password?token=nope", { method: "GET" });
    expect(badPeek.status).toBe(422);
  });

  it("change password keeps this session and signs out the others", async () => {
    const { user } = await makeUser();
    await signInAs(user.email);
    const other = jar.cookies.get("axs_session");
    freshBrowser();
    await signInAs(user.email);
    const current = jar.cookies.get("axs_session");

    const wrong = await call(passwordPOST as Handler, "/api/me/password", { body: { current: "Wrong1password", next: OTHER_PASSWORD } });
    expect(wrong.status).toBe(422);
    expect(((await bodyOf(wrong)).error as { fieldErrors: Record<string, string[]> }).fieldErrors).toEqual({ current: ["Your current password is incorrect."] });

    const res = await call(passwordPOST as Handler, "/api/me/password", { body: { current: PASSWORD, next: OTHER_PASSWORD } });
    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({ revokedSessions: 1 });
    expect(await resolveSession(db, current)).not.toBeNull();
    expect(await resolveSession(db, other)).toBeNull();
  });
});

describe("session routes", () => {
  it("lists sessions and signs out others or one, scoped to the user", async () => {
    const { user } = await makeUser();
    const stranger = await makeUser();
    await signInAs(stranger.user.email);
    const strangerSession = (await resolveSession(db, jar.cookies.get("axs_session")))?.session.id ?? "";
    freshBrowser();
    await signInAs(user.email);
    freshBrowser();
    await signInAs(user.email);

    const list = await call(sessionsGET as Handler, "/api/me/sessions", { method: "GET" });
    const { sessions } = (await bodyOf(list)) as { sessions: { id: string; current: boolean; device: string }[] };
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ current: true, device: "Chrome on Windows" });

    const foreign = await call(sessionDELETE as Handler, `/api/me/sessions/${strangerSession}`, { method: "DELETE", ctx: { params: Promise.resolve({ id: strangerSession }) } });
    expect(foreign.status).toBe(404);

    const others = await call(sessionsDELETE as Handler, "/api/me/sessions", { method: "DELETE" });
    expect(await bodyOf(others)).toEqual({ revoked: 1 });

    const currentId = sessions[0]?.id ?? "";
    const self = await call(sessionDELETE as Handler, `/api/me/sessions/${currentId}`, { method: "DELETE", ctx: { params: Promise.resolve({ id: currentId }) } });
    expect(await bodyOf(self)).toEqual({ revoked: true, current: true, device: "Chrome on Windows" });
    expect(jar.cookies.has("axs_session")).toBe(false);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
