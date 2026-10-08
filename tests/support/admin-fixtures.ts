/**
 * Fixtures for admin API tests: staff of each role and a customer with sessions and CSRF tokens, a route caller that
 * behaves like the admin console in a browser (same origin, cookies, x-csrf-token), registry path helpers and route
 * file discovery. Not a test file.
 *
 * Route calls read cookies through a next/headers mock that the test file installs over a shared cookie jar:
 *
 *   const jar = vi.hoisted(() => new Map<string, string>());
 *   vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));
 *
 * Rows get unique emails because DB test files share one schema per run.
 */
import { randomBytes } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { NextRequest } from "next/server";
import type { StaffRole, StaffStatus, User } from "@/generated/prisma/client";
import { csrfBinding, issueCsrfToken } from "@/lib/auth/csrf";
import { createSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { can, STAFF_ROLES, type Permission } from "@/lib/rbac";

export type CookieJar = Map<string, string>;

const tag = () => randomBytes(4).toString("hex");

export const STAFF_NAMES: Record<StaffRole, string> = {
  OWNER: "Anita Desai",
  ADMIN: "Vikram Rao",
  SUPPORT: "Sneha Patil",
  FINANCE: "Karan Mehta",
};

/**
 * An active (or invited/deactivated) staff member without a password (tests sign in by creating a session). Two-step
 * sign-in is off unless `twoStep` is set: it is each person's own choice, for every role (decisions.md 2026-10-08).
 */
export async function makeStaff(role: StaffRole, opts: { status?: StaffStatus; name?: string; twoStep?: boolean } = {}): Promise<User> {
  return db.user.create({
    data: {
      email: `admin-fx.${role.toLowerCase()}.${tag()}@axiomatic.test`,
      name: opts.name ?? STAFF_NAMES[role],
      kind: "STAFF",
      staffRole: role,
      staffStatus: opts.status ?? "ACTIVE",
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
      twoStepEnabled: opts.twoStep ?? false,
    },
  });
}

/** A verified customer who owns a new business account. */
export async function makeCustomer(): Promise<{ user: User; accountId: string }> {
  const user = await db.user.create({
    data: {
      email: `admin-fx.customer.${tag()}@example.test`,
      name: "Priya Sharma",
      kind: "CUSTOMER",
      emailVerifiedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  const account = await db.businessAccount.create({ data: { legalName: `Sharma Medicals ${tag()}` } });
  await db.accountMember.create({ data: { accountId: account.id, userId: user.id, role: "OWNER" } });
  return { user, accountId: account.id };
}

/** Session cookie token plus the CSRF token bound to it (what the browser holds after sign-in). */
export type TestSession = { user: User; sessionId: string; token: string; csrf: string };

export async function startSession(user: User, opts: { activeAccountId?: string } = {}): Promise<TestSession> {
  const { token, session } = await createSession(db, { userId: user.id, kind: user.kind, activeAccountId: opts.activeAccountId ?? null });
  return { user, sessionId: session.id, token, csrf: issueCsrfToken(csrfBinding(session.id), getEnv().CSRF_SECRET) };
}

/** The six callers of the permission matrix. */
export type CallerKey = "signedOut" | "customer" | StaffRole;
export const CALLERS: readonly CallerKey[] = ["signedOut", "customer", ...STAFF_ROLES];

export type AdminCallers = { customer: TestSession } & Record<StaffRole, TestSession>;

/** One signed-in customer and one active staff member per role. */
export async function makeAdminCallers(): Promise<AdminCallers> {
  const customer = await makeCustomer();
  const sessions = {} as Record<StaffRole, TestSession>;
  for (const role of STAFF_ROLES) sessions[role] = await startSession(await makeStaff(role));
  return { customer: await startSession(customer.user, { activeAccountId: customer.accountId }), ...sessions };
}

export function sessionFor(callers: AdminCallers, key: CallerKey): TestSession | null {
  return key === "signedOut" ? null : callers[key];
}

export type ExpectedOutcome = 401 | 403 | "allowed";

/** api-contracts section 7: signed out 401, customers 403, staff 403 without the permission, otherwise allowed. */
export function expectedOutcome(perm: Permission | null, caller: CallerKey, alsoRequires: readonly Permission[] = []): ExpectedOutcome {
  if (caller === "signedOut") return 401;
  if (caller === "customer") return 403;
  if (!alsoRequires.every((p) => can(caller, p))) return 403;
  return perm === null || can(caller, perm) ? "allowed" : 403;
}

/** Puts a session's cookies in the jar (or empties it for a signed-out caller). */
export function setJarSession(jar: CookieJar, session: TestSession | null): void {
  jar.clear();
  if (!session) return;
  jar.set("axs_session", session.token);
  jar.set("axs_csrf", session.csrf);
}

/** A next/headers replacement over `jar`: cookies() reads and writes the jar, headers() is empty. */
export function nextHeadersMock(jar: CookieJar) {
  return {
    cookies: async () => ({
      get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
      set: (name: string, value: string, options: { maxAge?: number } = {}) => {
        if (options.maxAge === 0 || value === "") jar.delete(name);
        else jar.set(name, value);
      },
    }),
    headers: async () => new Headers(),
  };
}

// ---------- Route calls ----------

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string | string[]>> }) => Promise<Response>;

export type CallOptions = {
  method?: string;
  /** Concrete path with query, e.g. "/api/admin/orders/AX-1/refund" or "/api/admin/orders?page=2". */
  path: string;
  params?: Record<string, string | string[]>;
  /** JSON body (sent with Content-Type: application/json). */
  body?: unknown;
  rawBody?: string;
  /** Caller; null = signed out. Replaces the jar's cookies. */
  session: TestSession | null;
  /** Send x-csrf-token from the session (default true). */
  csrf?: boolean;
  /** Origin header (default the app origin; null = none). */
  origin?: string | null;
  headers?: Record<string, string>;
};

/** Calls a route handler the way the admin console does in a browser. */
export async function callRoute(jar: CookieJar, handler: unknown, opts: CallOptions): Promise<Response> {
  setJarSession(jar, opts.session);
  const appUrl = getEnv().APP_URL;
  const headers = new Headers({ "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/129.0 Safari/537.36" });
  if (opts.origin !== null) headers.set("origin", opts.origin ?? new URL(appUrl).origin);
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers.set("content-type", "application/json");
  if (opts.session) {
    headers.set("cookie", `axs_session=${opts.session.token}; axs_csrf=${opts.session.csrf}`);
    if (opts.csrf !== false) headers.set("x-csrf-token", opts.session.csrf);
  }
  for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);
  const req = new NextRequest(new URL(opts.path, appUrl), { method: opts.method ?? "GET", headers, body });
  return (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) });
}

export async function errorCodeOf(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === "string" ? body.error.code : null;
  } catch {
    return null;
  }
}

// ---------- Registry paths and route files ----------

/** Dummy value for every dynamic segment in the permission test (no record has this id). */
export const DUMMY_SEGMENT = "perm-test-0000";

const SEGMENT = /^\[(\[)?(\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)\]?\]$/;

/**
 * "/api/admin/orders/[id]/refund" -> url "/api/admin/orders/perm-test-0000/refund" and params { id: "perm-test-0000" }.
 * Catch-all segments get one value; `overrides` replaces any segment's value.
 */
export function materializeRoutePath(
  pattern: string,
  overrides: Record<string, string | string[]> = {},
): { url: string; params: Record<string, string | string[]> } {
  const params: Record<string, string | string[]> = {};
  const parts = pattern.split("/").flatMap((part) => {
    const m = SEGMENT.exec(part);
    if (!m) return [part];
    const name = m[3] as string;
    const catchAll = Boolean(m[2]);
    const value = overrides[name] ?? (catchAll ? [DUMMY_SEGMENT] : DUMMY_SEGMENT);
    params[name] = catchAll && typeof value === "string" ? [value] : value;
    return (Array.isArray(value) ? value : [value]).map(encodeURIComponent);
  });
  return { url: parts.join("/"), params };
}

/** "app/api/admin/(x)/orders/[id]/route.ts" -> "/api/admin/orders/[id]" (route groups dropped). */
export function routePathFromFile(relativeFile: string): string {
  const parts = relativeFile.split(/[\\/]/).filter(Boolean);
  if (parts[0] === "app") parts.shift();
  parts.pop(); // route.ts
  return `/${parts.filter((p) => !/^\(.*\)$/.test(p)).join("/")}`;
}

export type DiscoveredRoute = { file: string; path: string };

const ROUTE_FILE = /^route\.(ts|tsx|js|mjs)$/;

/** Every route file under app/api/admin (private `_folders` are not routes and are skipped). */
export function discoverAdminRouteFiles(root: string = process.cwd()): DiscoveredRoute[] {
  return discoverRouteFiles(["api", "admin"], root);
}

/** Every route file under app/<segments...>, sorted by path. */
export function discoverRouteFiles(segments: readonly string[], root: string = process.cwd()): DiscoveredRoute[] {
  const base = join(root, "app", ...segments);
  const found: DiscoveredRoute[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (!name.startsWith("_")) walk(full);
      } else if (ROUTE_FILE.test(name)) {
        const rel = relative(root, full).split(sep).join("/");
        found.push({ file: full, path: routePathFromFile(rel) });
      }
    }
  };
  walk(base);
  return found;
}
