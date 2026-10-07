/**
 * Table-driven admin permission test (test-plan "Permissions", api-contracts section 7, decisions.md Phase 6).
 *
 * 1. Registry vs disk: every route file under app/api/admin is found at run time; each exported method must have an
 *    entry in lib/admin/routes (so a module builder cannot forget one), every entry must point at an exported
 *    handler, and the handler must be built with adminRoute() using the registered permission.
 * 2. Matrix: every entry x every caller. Signed out -> 401, customer -> 403, staff without the permission -> 403
 *    (`forbidden`, not a CSRF failure), staff with it -> anything but 401/403 (a dummy id and the entry's sampleBody,
 *    so 404/409/422 are expected). Mutations also refuse a missing CSRF token. Allowed responses are no-store.
 * 3. The api-contracts examples: Support cannot refund, revoke, change prices, view settings or audit; Finance can
 *    refund but not revoke. Each runs against the real route (a missing route fails).
 * 4. adminRoute() itself, through probe handlers (the same matrix on a known permission, CSRF, cross-site, bodies,
 *    error mapping, context).
 */
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { adminRoute, adminRouteMeta, CROSS_SITE_MESSAGE, idParam, type AdminRouteContext } from "@/lib/admin/http";
import { ADMIN_ROUTE_METHODS, ADMIN_ROUTES, adminRouteKey, type AdminRouteMethod, type RegisteredAdminRoute } from "@/lib/admin/routes";
import { ApiError, json } from "@/lib/http";
import { can, isPermission, type Permission } from "@/lib/rbac";
import { db } from "@/lib/db";
import {
  CALLERS,
  callRoute,
  discoverAdminRouteFiles,
  discoverRouteFiles,
  DUMMY_SEGMENT,
  errorCodeOf,
  expectedOutcome,
  makeAdminCallers,
  makeStaff,
  materializeRoutePath,
  routePathFromFile,
  sessionFor,
  startSession,
  type AdminCallers,
  type CallerKey,
} from "../support/admin-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async () => (await import("../support/admin-fixtures")).nextHeadersMock(jar));

const DISCOVERED = discoverAdminRouteFiles();
const BODY_METHODS = new Set<string>(["POST", "PUT", "PATCH", "DELETE"]);

type LoadedFile = { file: string; path: string; exports: Record<string, unknown> | null; error: string | null };
const loaded = new Map<string, LoadedFile>();
let callers: AdminCallers;
const serverErrors: string[] = [];

beforeAll(async () => {
  callers = await makeAdminCallers();
  for (const route of DISCOVERED) {
    try {
      const mod = (await import(/* @vite-ignore */ pathToFileURL(route.file).href)) as Record<string, unknown>;
      loaded.set(route.path, { ...route, exports: mod, error: null });
    } catch (e) {
      loaded.set(route.path, { ...route, exports: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
});

afterAll(() => {
  jar.clear();
});

function handlerFor(route: { method: AdminRouteMethod; path: string }): unknown {
  return loaded.get(route.path)?.exports?.[route.method];
}

/** Sends `route` as `caller` (dummy ids, sampleBody, CSRF token unless `csrf: false`). */
async function send(route: RegisteredAdminRoute, caller: CallerKey, opts: { csrf?: boolean } = {}): Promise<Response> {
  const { url, params } = materializeRoutePath(route.path, route.sampleParams);
  const body = BODY_METHODS.has(route.method) ? (route.sampleBody === undefined ? {} : route.sampleBody) : undefined;
  return callRoute(jar, handlerFor(route), {
    method: route.method,
    path: route.sampleQuery ? `${url}?${route.sampleQuery}` : url,
    params,
    body,
    session: sessionFor(callers, caller),
    csrf: opts.csrf,
  });
}

async function expectOutcome(
  res: Response,
  perm: Permission | null,
  caller: CallerKey,
  label: string,
  alsoRequires: readonly Permission[] = [],
): Promise<void> {
  const expected = expectedOutcome(perm, caller, alsoRequires);
  const code = await errorCodeOf(res);
  if (expected === "allowed") {
    expect([401, 403], `${label} as ${caller}: expected allowed, got ${res.status} ${code ?? ""}`).not.toContain(res.status);
    expect(res.headers.get("cache-control"), `${label} as ${caller}: no-store`).toContain("no-store");
    if (res.status >= 500) serverErrors.push(`${label} as ${caller}: ${res.status} ${code ?? ""}`);
  } else {
    expect(res.status, `${label} as ${caller}`).toBe(expected);
    expect(code, `${label} as ${caller}`).toBe(expected === 401 ? "unauthorized" : "forbidden");
  }
}

describe("admin route registry", () => {
  it("registers every handler exported by a route file under app/api/admin", () => {
    const importErrors = [...loaded.values()].filter((f) => f.error).map((f) => `${f.path}: ${f.error}`);
    expect(importErrors, "route files that could not be imported").toEqual([]);
    const registered = new Set(ADMIN_ROUTES.map(adminRouteKey));
    const missing: string[] = [];
    for (const file of loaded.values()) {
      for (const method of ADMIN_ROUTE_METHODS) {
        if (typeof file.exports?.[method] === "function" && !registered.has(adminRouteKey({ method, path: file.path }))) {
          missing.push(adminRouteKey({ method, path: file.path }));
        }
      }
      for (const name of ["HEAD", "OPTIONS"]) {
        expect(file.exports?.[name], `${file.path} exports ${name}; admin routes use ${ADMIN_ROUTE_METHODS.join("/")}`).toBeUndefined();
      }
    }
    expect(missing, "add these to the area's file in lib/admin/routes").toEqual([]);
  });

  it("points every registry entry at an exported handler", () => {
    const stale = ADMIN_ROUTES.filter((r) => typeof handlerFor(r) !== "function").map((r) => `${adminRouteKey(r)} (${r.area})`);
    expect(stale, "registry entries without a route handler").toEqual([]);
  });

  it("has well-formed, unique entries", () => {
    const keys = ADMIN_ROUTES.map(adminRouteKey);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i), "duplicate entries").toEqual([]);
    for (const r of ADMIN_ROUTES) {
      expect(r.path, adminRouteKey(r)).toMatch(/^\/api\/admin(\/[A-Za-z0-9._\-[\]]+)+$/);
      expect(ADMIN_ROUTE_METHODS, adminRouteKey(r)).toContain(r.method);
      expect(r.perm === null || isPermission(r.perm), adminRouteKey(r)).toBe(true);
      for (const p of r.alsoRequires ?? []) expect(isPermission(p), adminRouteKey(r)).toBe(true);
    }
  });

  it("builds every handler with adminRoute() and the registered permission", () => {
    const wrong: string[] = [];
    for (const r of ADMIN_ROUTES) {
      const handler = handlerFor(r);
      if (typeof handler !== "function") continue; // reported above
      const meta = adminRouteMeta(handler);
      if (!meta) wrong.push(`${adminRouteKey(r)}: not built with adminRoute()`);
      else if (meta.perm !== r.perm) wrong.push(`${adminRouteKey(r)}: handler requires ${meta.perm ?? "any staff"}, registry says ${r.perm ?? "any staff"}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe("permission matrix: every admin route x every caller", () => {
  it(`covers ${ADMIN_ROUTES.length} registered routes and ${DISCOVERED.length} route files`, () => {
    expect(ADMIN_ROUTES.length).toBeGreaterThanOrEqual(0);
  });

  for (const route of ADMIN_ROUTES) {
    const label = adminRouteKey(route);
    describe(`${label} (${[route.perm ?? "any staff", ...(route.alsoRequires ?? [])].join(" + ")})`, () => {
      it.each(CALLERS)("as %s", async (caller) => {
        if (typeof handlerFor(route) !== "function") return; // reported by the registry tests
        await expectOutcome(await send(route, caller), route.perm, caller, label, route.alsoRequires);
      });

      if (BODY_METHODS.has(route.method)) {
        it("refuses a mutation without the CSRF token", async () => {
          if (typeof handlerFor(route) !== "function") return;
          const res = await send(route, "OWNER", { csrf: false });
          expect(res.status, label).toBe(403);
          expect(await errorCodeOf(res), label).toBe("csrf_failed");
        });
      }
    });
  }

  it("no route answers 5xx to a permitted caller with the sample input", () => {
    expect(serverErrors, "handlers should answer 404/409/422 for the dummy id and sampleBody").toEqual([]);
  });
});

/** api-contracts section 7 / test-plan "Permissions": named cases, matched by method and path. */
const EXPLICIT_CASES: { title: string; method: AdminRouteMethod; match: RegExp; caller: CallerKey; outcome: 403 | "allowed" }[] = [
  { title: "Support cannot refund", method: "POST", match: /^\/api\/admin\/orders\/\[[^\]]+\]\/refund$/, caller: "SUPPORT", outcome: 403 },
  { title: "Support cannot revoke a license", method: "POST", match: /^\/api\/admin\/licenses\/\[[^\]]+\]\/revoke$/, caller: "SUPPORT", outcome: 403 },
  { title: "Support cannot change prices", method: "PATCH", match: /^\/api\/admin\/plans\/\[[^\]]+\]$/, caller: "SUPPORT", outcome: 403 },
  { title: "Support cannot view settings", method: "GET", match: /^\/api\/admin\/settings(\/|$)/, caller: "SUPPORT", outcome: 403 },
  { title: "Support cannot view the audit log", method: "GET", match: /^\/api\/admin\/audit(\/|$)/, caller: "SUPPORT", outcome: 403 },
  { title: "Finance can refund", method: "POST", match: /^\/api\/admin\/orders\/\[[^\]]+\]\/refund$/, caller: "FINANCE", outcome: "allowed" },
  { title: "Finance cannot revoke a license", method: "POST", match: /^\/api\/admin\/licenses\/\[[^\]]+\]\/revoke$/, caller: "FINANCE", outcome: 403 },
];

describe("api-contracts examples", () => {
  it("hold in lib/rbac.ts", () => {
    expect(can("SUPPORT", "refunds.issue")).toBe(false);
    expect(can("SUPPORT", "licenses.revoke")).toBe(false);
    expect(can("SUPPORT", "pricing.manage")).toBe(false);
    expect(can("SUPPORT", "settings.manage")).toBe(false);
    expect(can("SUPPORT", "audit.view")).toBe(false);
    expect(can("FINANCE", "refunds.issue")).toBe(true);
    expect(can("FINANCE", "licenses.revoke")).toBe(false);
  });

  for (const c of EXPLICIT_CASES) {
    const routes = ADMIN_ROUTES.filter((r) => r.method === c.method && c.match.test(r.path));
    it(`${c.title} (${routes.length > 0 ? routes.map(adminRouteKey).join(", ") : "route not registered"})`, async () => {
      expect(routes.length, `${c.method} ${c.match} must be registered`).toBeGreaterThan(0);
      for (const route of routes) {
        const res = await send(route, c.caller);
        if (c.outcome === "allowed") expect([401, 403], adminRouteKey(route)).not.toContain(res.status);
        else {
          expect(res.status, adminRouteKey(route)).toBe(403);
          expect(await errorCodeOf(res)).toBe("forbidden");
        }
      }
    });
  }
});

// ---------- adminRoute() itself ----------

type Probe = { staff: AdminRouteContext["staff"]; actor: AdminRouteContext["actor"]; params: Record<string, string>; canRevoke: boolean };
const probeBody = z.strictObject({ note: z.string().max(20) });
const probeGet = adminRoute<{ id: string }>("refunds.issue", async (ctx) =>
  json<Probe>({ staff: ctx.staff, actor: ctx.actor, params: ctx.params, canRevoke: ctx.can("licenses.revoke") }),
);
const probePost = adminRoute<{ id: string }>(
  "refunds.issue",
  async (ctx) => {
    const input = await ctx.body(probeBody);
    return json({ id: idParam(ctx.params, "id", "Order"), note: input.note }, { status: 201 });
  },
  { maxBodyBytes: 256 },
);
const probeAnyStaff = adminRoute(null, async () => json({ ok: true }));
const probeLoose = adminRoute(null, async (ctx) => json(await ctx.body(z.object({ note: z.string() }))));
const probeThrows = adminRoute(null, async (ctx) => {
  const kind = ctx.req.nextUrl.searchParams.get("kind");
  if (kind === "api") throw new ApiError(409, "already_done", "Already done.");
  if (kind === "perm") ctx.requirePerm("settings.manage");
  throw new Error("boom");
});
const probeRedirect = adminRoute(null, async () => Response.redirect("https://example.test/elsewhere", 302));

const probeRoute = (method: AdminRouteMethod): RegisteredAdminRoute => ({
  method,
  path: "/api/admin/probe/[id]",
  perm: "refunds.issue",
  area: "foundation",
  sampleBody: { note: "hello" },
});

describe("adminRoute()", () => {
  it("tags handlers with their permission", () => {
    expect(adminRouteMeta(probeGet)).toEqual({ perm: "refunds.issue", mutation: false });
    expect(adminRouteMeta(probeAnyStaff)).toEqual({ perm: null, mutation: false });
    expect(adminRouteMeta(adminRoute(null, async () => json({}), { mutation: true }))).toEqual({ perm: null, mutation: true });
    expect(adminRouteMeta(() => undefined)).toBeNull();
    expect(adminRouteMeta({})).toBeNull();
  });

  it.each(CALLERS)("applies the permission matrix to GET and POST as %s", async (caller) => {
    for (const method of ["GET", "POST"] as const) {
      const route = probeRoute(method);
      const res = await callRoute(jar, method === "GET" ? probeGet : probePost, {
        method,
        path: "/api/admin/probe/AX-10301",
        params: { id: "AX-10301" },
        body: method === "POST" ? route.sampleBody : undefined,
        session: sessionFor(callers, caller),
      });
      await expectOutcome(res, "refunds.issue", caller, `${method} probe`);
      if (expectedOutcome("refunds.issue", caller) === "allowed") expect(res.status).toBe(method === "GET" ? 200 : 201);
    }
  });

  it("lets any active staff member through a null permission, nobody else", async () => {
    for (const caller of CALLERS) {
      const res = await callRoute(jar, probeAnyStaff, { path: "/api/admin/probe", session: sessionFor(callers, caller) });
      await expectOutcome(res, null, caller, "GET any-staff probe");
    }
  });

  it("refuses invited and deactivated staff", async () => {
    const invited = await startSession(await makeStaff("OWNER", { status: "INVITED" }));
    const res = await callRoute(jar, probeAnyStaff, { path: "/api/admin/probe", session: invited });
    expect(res.status).toBe(403);
    const deactivated = await makeStaff("OWNER");
    const session = await startSession(deactivated);
    await db.user.update({ where: { id: deactivated.id }, data: { staffStatus: "DEACTIVATED" } });
    expect((await callRoute(jar, probeAnyStaff, { path: "/api/admin/probe", session })).status).toBe(401);
  });

  it("passes the staff member, audit actor and awaited params to the handler", async () => {
    const res = await callRoute(jar, probeGet, { path: "/api/admin/probe/AX-10301", params: { id: "AX-10301" }, session: callers.FINANCE });
    const body = (await res.json()) as Probe;
    expect(body.staff).toEqual({
      id: callers.FINANCE.user.id,
      name: callers.FINANCE.user.name,
      email: callers.FINANCE.user.email,
      role: "FINANCE",
      sessionId: callers.FINANCE.sessionId,
    });
    expect(body.actor).toEqual({ id: callers.FINANCE.user.id, role: "finance", ipPrefix: null });
    expect(body.params).toEqual({ id: "AX-10301" });
    expect(body.canRevoke).toBe(false);
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("needs the CSRF token and the app origin for mutations", async () => {
    const base = { method: "POST", path: "/api/admin/probe/AX-1", params: { id: "AX-1" }, body: { note: "x" }, session: callers.OWNER } as const;
    const noToken = await callRoute(jar, probePost, { ...base, csrf: false });
    expect(noToken.status).toBe(403);
    expect(await errorCodeOf(noToken)).toBe("csrf_failed");
    const foreign = await callRoute(jar, probePost, { ...base, origin: "https://evil.example" });
    expect(await errorCodeOf(foreign)).toBe("csrf_failed");
    const otherSession = await callRoute(jar, probePost, { ...base, headers: { "x-csrf-token": callers.FINANCE.csrf } });
    expect(await errorCodeOf(otherSession)).toBe("csrf_failed");
    expect((await callRoute(jar, probePost, base)).status).toBe(201);
  });

  it("does not need CSRF for GET unless the route says so", async () => {
    const forced = adminRoute(null, async () => json({ ok: true }), { mutation: true });
    expect((await callRoute(jar, probeAnyStaff, { path: "/api/admin/probe", session: callers.OWNER, csrf: false })).status).toBe(200);
    const res = await callRoute(jar, forced, { path: "/api/admin/probe", session: callers.OWNER, csrf: false });
    expect(await errorCodeOf(res)).toBe("csrf_failed");
  });

  it("refuses cross-site requests, even downloads", async () => {
    const res = await callRoute(jar, probeAnyStaff, { path: "/api/admin/probe", session: callers.OWNER, headers: { "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(CROSS_SITE_MESSAGE);
    const sameSite = await callRoute(jar, probeAnyStaff, { path: "/api/admin/probe", session: callers.OWNER, headers: { "sec-fetch-site": "same-origin" } });
    expect(sameSite.status).toBe(200);
  });
});

describe("adminRoute() bodies, errors and caching", () => {
  const post = (body: Partial<Parameters<typeof callRoute>[2]>) =>
    callRoute(jar, probePost, { method: "POST", path: "/api/admin/probe/AX-1", params: { id: "AX-1" }, session: callers.OWNER, ...body });

  it("validates bodies with the strict schema", async () => {
    const unknownKey = await post({ body: { note: "x", extra: true } });
    expect(unknownKey.status).toBe(422);
    expect(await unknownKey.json()).toMatchObject({ error: { code: "validation_failed", fieldErrors: { extra: ["Unknown field."] } } });
    expect((await post({ rawBody: "{nope" })).status).toBe(400);
    expect((await post({ body: { note: "x".repeat(400) } })).status).toBe(413);
    const text = await callRoute(jar, probePost, {
      method: "POST",
      path: "/api/admin/probe/AX-1",
      params: { id: "AX-1" },
      session: callers.OWNER,
      rawBody: "note=x",
      headers: { "content-type": "text/plain" },
    });
    expect(text.status).toBe(415);
  });

  it("refuses non-strict body schemas outside production", async () => {
    const res = await callRoute(jar, probeLoose, { method: "POST", path: "/api/admin/probe", body: { note: "x" }, session: callers.OWNER });
    expect(res.status).toBe(500);
  });

  it("answers 404 for malformed ids", async () => {
    const res = await post({ params: { id: "../../etc" }, body: { note: "x" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "not_found", message: "Order not found." } });
    expect(() => idParam({ id: ["a", "b"] })).toThrow(ApiError);
    expect(() => idParam({}, "id")).toThrow(ApiError);
    expect(idParam({ id: "LIC-24017" })).toBe("LIC-24017");
    expect(idParam({ eventId: "reconcile:pay_9xk2" }, "eventId")).toBe("reconcile:pay_9xk2");
  });

  it("maps thrown errors to the envelope, always no-store", async () => {
    const api = await callRoute(jar, probeThrows, { path: "/api/admin/probe?kind=api", session: callers.SUPPORT });
    expect(api.status).toBe(409);
    expect(await api.json()).toEqual({ error: { code: "already_done", message: "Already done." } });
    expect(api.headers.get("cache-control")).toBe("no-store");
    const perm = await callRoute(jar, probeThrows, { path: "/api/admin/probe?kind=perm", session: callers.SUPPORT });
    expect(perm.status).toBe(403);
    expect(await perm.json()).toEqual({ error: { code: "forbidden", message: "Your role (Support) doesn\u2019t allow this." } });
    const crash = await callRoute(jar, probeThrows, { path: "/api/admin/probe?kind=crash", session: callers.SUPPORT });
    expect(crash.status).toBe(500);
    expect(await errorCodeOf(crash)).toBe("internal_error");
    const denied = await callRoute(jar, probeGet, { path: "/api/admin/probe/AX-1", params: { id: "AX-1" }, session: callers.SUPPORT });
    expect(denied.headers.get("cache-control")).toBe("no-store");
  });

  it("forces no-store even on responses with immutable headers", async () => {
    const res = await callRoute(jar, probeRedirect, { path: "/api/admin/probe", session: callers.OWNER });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.test/elsewhere");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("test harness", () => {
  it("maps route files to registry paths", () => {
    expect(routePathFromFile("app/api/admin/orders/[id]/refund/route.ts")).toBe("/api/admin/orders/[id]/refund");
    expect(routePathFromFile("app\\api\\admin\\(catalog)\\plans\\route.ts")).toBe("/api/admin/plans");
    expect(routePathFromFile("app/api/admin/reports/export.csv/route.ts")).toBe("/api/admin/reports/export.csv");
  });

  it("fills dynamic segments with a dummy id", () => {
    expect(materializeRoutePath("/api/admin/orders/[id]/refund")).toEqual({
      url: `/api/admin/orders/${DUMMY_SEGMENT}/refund`,
      params: { id: DUMMY_SEGMENT },
    });
    expect(materializeRoutePath("/api/admin/licenses/[id]/devices/[deviceId]", { deviceId: "dev 1" })).toEqual({
      url: `/api/admin/licenses/${DUMMY_SEGMENT}/devices/dev%201`,
      params: { id: DUMMY_SEGMENT, deviceId: "dev 1" },
    });
    expect(materializeRoutePath("/api/admin/files/[...key]").params).toEqual({ key: [DUMMY_SEGMENT] });
  });

  it("discovers and imports route files at run time (checked on the portal routes)", async () => {
    const portal = discoverRouteFiles(["api", "account"]);
    const device = portal.find((r) => r.path === "/api/account/devices/[id]");
    expect(device).toBeDefined();
    const mod = (await import(/* @vite-ignore */ pathToFileURL(device?.file ?? "").href)) as Record<string, unknown>;
    expect(typeof mod.PATCH).toBe("function");
    // A handler not built with adminRoute() is what the registry test reports.
    expect(adminRouteMeta(mod.PATCH)).toBeNull();
  });
});
