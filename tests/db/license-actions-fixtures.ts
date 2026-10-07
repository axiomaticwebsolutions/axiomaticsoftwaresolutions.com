/**
 * Fixtures for the account license action DB tests (tests/db/license-actions-*.test.ts). Not a test file itself.
 * Rows get unique ids because DB test files share one schema per run. Route calls go through a cookie jar that the
 * test file wires into a next/headers mock (see the test files).
 */
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import type { LicenseStatus, Plan, Product, TeamRole, User } from "@/generated/prisma/client";
import { csrfBinding, issueCsrfToken } from "@/lib/auth/csrf";
import { createSession } from "@/lib/auth/sessions";
import { istCalendarYear } from "@/lib/dates";
import { db } from "@/lib/db";
import { getEnv, getLicenseKeySecrets } from "@/lib/env";
import { sealLicenseKey } from "@/lib/licensing/crypto";
import { generateLicenseKey } from "@/lib/licensing/keys";
import { freshProductCode } from "../support/product-codes";
import { passwordHashOf, PASSWORD, uniqueEmail } from "./auth-fixtures";

export { PASSWORD };
export const DAY = 86_400_000;
const tag = () => randomBytes(4).toString("hex");

export type Catalog = { product: Product; annual: Plan; oneTime: Plan; amc: Plan; addon: Plan; trial: Plan };

/** A published product with annual, one-time, maintenance, device add-on and trial plans. */
export async function makeCatalog(): Promise<Catalog> {
  const t = tag();
  const category = await db.category.create({ data: { id: `la-cat-${t}`, name: "License actions", tone: "sage", icon: "key" } });
  const product = await db.product.create({
    data: {
      id: `la-product-${t}`,
      code: await freshProductCode(),
      name: `Medical Store Billing ${t}`,
      shortName: "Medical",
      tagline: "Test",
      summary: "Test",
      icon: "medication",
      categoryId: category.id,
      platforms: ["windows"],
      status: "PUBLISHED",
      content: {},
      relatedIds: [],
    },
  });
  const plan = (id: string, data: Partial<Plan> & Pick<Plan, "type">) =>
    db.plan.create({ data: { id: `${id}-${t}`, productId: product.id, name: id, includes: [], pricePaise: 100_000, ...data } });
  return {
    product,
    annual: await plan("la-annual", { type: "ANNUAL", interval: "YEAR", deviceLimit: 3, pricePaise: 600_000 }),
    oneTime: await plan("la-onetime", { type: "ONE_TIME", deviceLimit: 1, updatesMonths: 12, pricePaise: 1_500_000 }),
    amc: await plan("la-amc", { type: "MAINTENANCE", interval: "YEAR", pricePaise: 300_000 }),
    addon: await plan("la-device", { type: "DEVICE_ADDON", pricePaise: 150_000 }),
    trial: await plan("la-trial", { type: "TRIAL", trialDays: 15, deviceLimit: 1, pricePaise: 0 }),
  };
}

export type Member = { user: User; accountId: string };

/** A customer and their membership: a new account they OWN, or `role` on an existing account. */
export async function makeMember(opts: { accountId?: string; role?: TeamRole; verified?: boolean; name?: string } = {}): Promise<Member> {
  const user = await db.user.create({
    data: {
      email: uniqueEmail("la"),
      name: opts.name ?? "Priya Sharma",
      kind: "CUSTOMER",
      passwordHash: await passwordHashOf(),
      emailVerifiedAt: opts.verified === false ? null : new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  const accountId = opts.accountId ?? (await db.businessAccount.create({ data: { legalName: `Sharma Medicals ${tag()}` } })).id;
  await db.accountMember.create({ data: { accountId, userId: user.id, role: opts.role ?? (opts.accountId ? "TECHNICAL" : "OWNER") } });
  return { user, accountId };
}

export type LicenseOptions = {
  accountId: string | null;
  plan?: Plan;
  status?: LicenseStatus;
  expiresAt?: Date | null;
  updatesUntil?: Date;
  deviceLimit?: number;
  selfServiceResets?: number;
  resetsYear?: number;
  issuedAt?: Date;
};

/** A license with a real sealed key (env secrets, so the reveal route can decrypt it). Returns the plaintext key. */
export async function makeLicense(catalog: Catalog, opts: LicenseOptions) {
  const key = generateLicenseKey(catalog.product.code);
  const sealed = sealLicenseKey(key, getLicenseKeySecrets());
  const now = new Date();
  const expiresAt = opts.expiresAt === undefined ? new Date(now.getTime() + 200 * DAY) : opts.expiresAt;
  const license = await db.license.create({
    data: {
      id: `LIC-T${tag().toUpperCase()}`,
      accountId: opts.accountId,
      productId: catalog.product.id,
      planId: (opts.plan ?? catalog.annual).id,
      ...sealed,
      status: opts.status ?? "ACTIVE",
      issuedAt: opts.issuedAt ?? new Date(now.getTime() - 100 * DAY),
      expiresAt,
      updatesUntil: opts.updatesUntil ?? expiresAt ?? new Date(now.getTime() + 200 * DAY),
      deviceLimit: opts.deviceLimit ?? 3,
      selfServiceResets: opts.selfServiceResets ?? 0,
      resetsYear: opts.resetsYear ?? istCalendarYear(now),
    },
  });
  return { license, key };
}

export async function makeDevice(
  licenseId: string,
  opts: { name?: string; os?: string; locationId?: string | null; lastSeenAt?: Date; deactivatedAt?: Date | null } = {},
) {
  return db.deviceActivation.create({
    data: {
      licenseId,
      fingerprint: randomBytes(32).toString("hex"),
      name: opts.name ?? `Counter PC ${tag()}`,
      os: opts.os ?? "Windows 11 Pro",
      locationId: opts.locationId ?? null,
      activatedAt: new Date(Date.now() - 50 * DAY),
      lastSeenAt: opts.lastSeenAt ?? new Date(),
      deactivatedAt: opts.deactivatedAt ?? null,
      deactivatedBy: opts.deactivatedAt ? "customer" : null,
    },
  });
}

export async function makeLocation(accountId: string, name: string) {
  return db.location.create({ data: { accountId, name } });
}

// ---------- Route calls ----------

export type CookieJar = Map<string, string>;
type Handler = (req: NextRequest, ctx: never) => Promise<Response>;
export type CallOptions = {
  method?: string;
  body?: unknown;
  rawBody?: string;
  csrf?: boolean;
  origin?: string | null;
  params?: Record<string, string>;
  /** Extra request headers (e.g. `sec-fetch-site`). */
  headers?: Record<string, string>;
};

/** Signs `member` in: a session on their account plus a CSRF token bound to it, both in the jar. */
export async function signIn(jar: CookieJar, member: Member): Promise<void> {
  jar.clear();
  const { token, session } = await createSession(db, { userId: member.user.id, kind: "CUSTOMER", activeAccountId: member.accountId });
  jar.set("axs_session", token);
  jar.set("axs_csrf", issueCsrfToken(csrfBinding(session.id), getEnv().CSRF_SECRET));
}

/** Calls a route handler like the browser would (same origin, cookies, x-csrf-token from the cookie). */
export async function call(jar: CookieJar, handler: unknown, path: string, opts: CallOptions = {}): Promise<Response> {
  const appUrl = getEnv().APP_URL;
  const headers = new Headers({ "user-agent": "Mozilla/5.0 (Windows NT 10.0) Chrome/129.0 Safari/537.36" });
  if (opts.origin !== null) headers.set("origin", opts.origin ?? new URL(appUrl).origin);
  for (const [name, value] of Object.entries(opts.headers ?? {})) headers.set(name, value);
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers.set("content-type", "application/json");
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  if (cookie) headers.set("cookie", cookie);
  const csrf = jar.get("axs_csrf");
  if (opts.csrf !== false && csrf) headers.set("x-csrf-token", csrf);
  const req = new NextRequest(`${appUrl}${path}`, { method: opts.method ?? "GET", headers, body });
  return (handler as Handler)(req, { params: Promise.resolve(opts.params ?? {}) } as never);
}

export async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

export function errorOf(body: Record<string, unknown>): { code: string; message: string } & Record<string, unknown> {
  return body.error as { code: string; message: string } & Record<string, unknown>;
}
