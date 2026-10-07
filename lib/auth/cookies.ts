/**
 * Session and CSRF cookies (Next.js request context only). Writes work in Route Handlers and Server Actions;
 * Server Components can only read.
 */
import "server-only";
import { cookies } from "next/headers";
import { CSRF_COOKIE } from "@/lib/auth/csrf";
import { getEnv } from "@/lib/env";

export const SESSION_COOKIE = "axs_session";

/** Secure cookies whenever the app is served over https, and always in production. */
export function cookieSecure(): boolean {
  const env = getEnv();
  return env.NODE_ENV === "production" || env.APP_URL.startsWith("https://");
}

/** httpOnly, SameSite=Lax, Path=/; expires with the session (call again when the idle window slides). */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", secure: cookieSecure(), expires: expiresAt });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", secure: cookieSecure(), maxAge: 0 });
}

/** The raw session token from the request cookie, or null. */
export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  return value ? value : null;
}

/**
 * The CSRF token cookie. Deliberately NOT httpOnly: client code reads it and echoes it in `x-csrf-token`.
 * Without `expiresAt` it is a browser-session cookie.
 */
export async function setCsrfCookie(token: string, expiresAt?: Date): Promise<void> {
  const store = await cookies();
  store.set(CSRF_COOKIE, token, { httpOnly: false, sameSite: "lax", path: "/", secure: cookieSecure(), expires: expiresAt });
}

export async function readCsrfCookie(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(CSRF_COOKIE)?.value;
  return value ? value : null;
}

export async function clearCsrfCookie(): Promise<void> {
  const store = await cookies();
  store.set(CSRF_COOKIE, "", { httpOnly: false, sameSite: "lax", path: "/", secure: cookieSecure(), maxAge: 0 });
}
