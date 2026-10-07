/**
 * Admin API foundation (decisions.md Phase 6). Every handler under app/api/admin is built with adminRoute():
 *
 *   export const POST = adminRoute<{ id: string }>("refunds.issue", async ({ params, staff, actor, body }) => {
 *     const input = await body(refundSchema);            // strict Zod, 422 validation_failed, 413 above maxBodyBytes
 *     ...
 *     return json({ refund });
 *   });
 *
 * In order: a cross-site request (Sec-Fetch-Site: cross-site) is refused (403), then requireStaff(perm) answers 401
 * signed out and 403 for customers, invited/deactivated staff and roles without `perm` ("Your role (Support) doesn't
 * allow this."). Methods other than GET/HEAD/OPTIONS (or `mutation: true`) then need the session-bound CSRF token and a
 * same-origin request (403 `csrf_failed`). Thrown ApiErrors and Zod errors become the error envelope, database outages
 * 503, anything else a logged 500. Every response, success or error, is `Cache-Control: no-store`.
 *
 * Each handler carries its permission (adminRouteMeta), which the table-driven permission test compares with the
 * route registry in lib/admin/routes.
 */
import "server-only";
import { unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { z } from "zod";
import type { StaffRole } from "@/generated/prisma/client";
import { actorFromStaff, type AuditActor } from "@/lib/audit";
import { assertCsrf, csrfBinding } from "@/lib/auth/csrf";
import { requireStaff } from "@/lib/auth/guards";
import { getEnv, isProduction } from "@/lib/env";
import { clientIp, DEFAULT_MAX_BODY_BYTES, errorResponse, errors, ipPrefix, parseJsonBody } from "@/lib/http";
import { can, roleForbiddenMessage, type Permission } from "@/lib/rbac";

/**
 * The signed-in staff member as admin handlers see it: lib/admin/context.ts AdminStaff plus the session id (never the
 * password hash or other secrets).
 */
export type AdminRequestStaff = { id: string; name: string; email: string; role: StaffRole; sessionId: string };

export type AdminParams = Record<string, string | string[]>;

export type AdminRouteContext<P extends AdminParams = Record<string, string>> = {
  req: NextRequest;
  /** Dynamic segments, already awaited. */
  params: P;
  staff: AdminRequestStaff;
  /** Audit actor for this staff member with the truncated client IP. */
  actor: AuditActor;
  /** Client IP as TRUSTED_PROXY_HOPS allows (null when unknown). */
  ip: string | null;
  /** Does this staff member hold `perm`? (For optional fields and finer checks.) */
  can: (perm: Permission) => boolean;
  /** Throws 403 unless this staff member holds `perm`. */
  requirePerm: (perm: Permission) => void;
  /** Reads the JSON body with a strict Zod schema (422 validation_failed, 415, 413 above maxBodyBytes). */
  body: <S extends z.ZodType>(schema: S) => Promise<z.output<S>>;
};

export type AdminRouteOptions = {
  /** Also require CSRF + same origin for a GET (other methods always require it). */
  mutation?: boolean;
  /** Body limit for ctx.body() (default 64 KB). */
  maxBodyBytes?: number;
};

export type AdminRouteMeta = { perm: Permission | null; mutation: boolean };

export type AdminRouteHandler<P extends AdminParams = Record<string, string>> = ((
  req: NextRequest,
  ctx: { params: Promise<P> },
) => Promise<Response>) & { readonly [ADMIN_ROUTE_META]: AdminRouteMeta };

/** Symbol.for, so the tag survives duplicated module graphs (Next bundles route handlers separately). */
export const ADMIN_ROUTE_META: unique symbol = Symbol.for("axs.admin.route");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const CROSS_SITE_MESSAGE = "This request must come from the admin console.";

/** The permission and CSRF mode a handler was built with, or null when it was not built with adminRoute(). */
export function adminRouteMeta(handler: unknown): AdminRouteMeta | null {
  if (typeof handler !== "function") return null;
  const meta = (handler as { [ADMIN_ROUTE_META]?: AdminRouteMeta })[ADMIN_ROUTE_META];
  return meta && typeof meta === "object" ? meta : null;
}

function isStrictObjectSchema(schema: z.ZodType): boolean {
  if (!(schema instanceof z.ZodObject)) return true;
  const catchall = schema.def.catchall;
  return !!catchall && catchall._zod.def.type === "never";
}

/** Response with `Cache-Control: no-store` (copies the response when its headers are immutable). */
export function withNoStore(res: Response): Response {
  try {
    res.headers.set("cache-control", "no-store");
    return res;
  } catch {
    const headers = new Headers(res.headers);
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

/**
 * Builds an admin route handler. `perm` null = any active staff member (still 401/403 for everyone else).
 * The handler runs only after the role and (for mutations) CSRF checks passed.
 */
export function adminRoute<P extends AdminParams = Record<string, string>>(
  perm: Permission | null,
  handler: (ctx: AdminRouteContext<P>) => Promise<Response>,
  opts: AdminRouteOptions = {},
): AdminRouteHandler<P> {
  const maxBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const run = async (req: NextRequest, routeCtx: { params: Promise<P> }): Promise<Response> => {
    try {
      if (req.headers.get("sec-fetch-site") === "cross-site") throw errors.forbidden(CROSS_SITE_MESSAGE);
      const { session, user } = await requireStaff(perm ?? undefined);
      const mutation = opts.mutation === true || !SAFE_METHODS.has(req.method.toUpperCase());
      if (mutation) {
        const env = getEnv();
        assertCsrf(req, { binding: csrfBinding(session.id), secret: env.CSRF_SECRET, appUrl: env.APP_URL });
      }
      const role = user.staffRole;
      const ip = clientIp(req);
      const params = ((await routeCtx?.params) ?? {}) as P;
      const ctx: AdminRouteContext<P> = {
        req,
        params,
        staff: { id: user.id, name: user.name, email: user.email, role, sessionId: session.id },
        actor: actorFromStaff(user, ipPrefix(ip)),
        ip,
        can: (p) => can(role, p),
        requirePerm: (p) => {
          if (!can(role, p)) throw errors.forbidden(roleForbiddenMessage(role));
        },
        body: async (schema) => {
          if (!isProduction() && !isStrictObjectSchema(schema)) {
            throw new Error("Admin request bodies need strict Zod objects (z.strictObject() or .strict()).");
          }
          return parseJsonBody(req, schema, { maxBytes });
        },
      };
      return withNoStore(await handler(ctx));
    } catch (e) {
      unstable_rethrow(e);
      return withNoStore(errorResponse(e, { method: req.method, path: safePath(req) }));
    }
  };
  const meta: AdminRouteMeta = Object.freeze({ perm, mutation: opts.mutation === true });
  Object.defineProperty(run, ADMIN_ROUTE_META, { value: meta, enumerable: false });
  return run as AdminRouteHandler<P>;
}

function safePath(req: Request): string | undefined {
  try {
    return new URL(req.url).pathname;
  } catch {
    return undefined;
  }
}

/** Longest id accepted from a URL segment; anything else is a 404 without a database query. */
const ID_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

/**
 * A single dynamic segment that looks like an id (order id, license id, cuid, coupon code, template id, event id),
 * else 404 "`what` not found." Catch-all arrays and missing segments are 404 too.
 */
export function idParam(params: AdminParams, key = "id", what?: string): string {
  const value = params[key];
  if (typeof value !== "string" || !ID_SEGMENT.test(value)) throw errors.notFound(what);
  return value;
}
