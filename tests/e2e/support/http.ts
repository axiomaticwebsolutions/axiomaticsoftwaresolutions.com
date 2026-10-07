/**
 * A tiny cookie-keeping HTTP client (Node fetch) for the app's JSON API with the double-submit CSRF token and the
 * same-origin header, as lib/client/api.ts sends them from a page.
 *
 * Why not the browser: seeded passwords and two-step codes must never land in Playwright traces or reports, so the
 * suite signs seeded people in here and hands only the resulting session cookie to the browser context
 * (auth.ts). Throwaway customers the suite creates may type their generated passwords in the UI.
 */
import type { BrowserContext } from "@playwright/test";
import { BASE_URL } from "./env";

export type ApiResult<T = unknown> = { status: number; body: T; headers: Headers };

export class HttpClient {
  private readonly jar = new Map<string, string>();

  constructor(cookies: ReadonlyArray<{ name: string; value: string }> = []) {
    for (const c of cookies) this.jar.set(c.name, c.value);
  }

  /** A client carrying the context's cookies for BASE_URL (e.g. to sign that session out). */
  static async fromContext(context: BrowserContext): Promise<HttpClient> {
    return new HttpClient(await context.cookies(BASE_URL));
  }

  cookies(): { name: string; value: string }[] {
    return [...this.jar].map(([name, value]) => ({ name, value }));
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }

  private absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = raw.split(";");
      const eq = pair.indexOf("=");
      if (eq < 1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a) || /^\s*expires=.*1970/i.test(a));
      if (expired || value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  private cookieHeader(): string {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.jar.size) headers.set("cookie", this.cookieHeader());
    const res = await fetch(`${BASE_URL}${path}`, { ...init, headers, redirect: "manual", cache: "no-store" });
    this.absorb(res);
    return res;
  }

  async csrf(): Promise<string> {
    const res = await this.fetch("/api/csrf");
    const body = (await res.json()) as { token?: string };
    if (!res.ok || !body.token) throw new Error(`GET /api/csrf answered ${res.status}`);
    return body.token;
  }

  /** JSON API call; mutating methods carry a fresh CSRF token. */
  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method !== "GET" && method !== "HEAD") {
      headers["x-csrf-token"] = await this.csrf();
      headers.origin = BASE_URL;
      if (body !== undefined) headers["content-type"] = "application/json";
    }
    const res = await this.fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  /** Puts this client's cookies into a browser context (signed-in session, CSRF cookie). */
  async exportTo(context: BrowserContext): Promise<void> {
    await context.addCookies(this.cookies().map((c) => ({ ...c, url: BASE_URL })));
  }
}

/** The machine-readable error code of an API error body ({ error: { code } }). */
export function errorCode(body: unknown): string {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : "";
}
