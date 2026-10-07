/**
 * POST /api/account/licenses/:id/reveal end to end: password re-auth, the per-user limit (counted before the check),
 * team roles, account scoping (IDOR), CSRF, and proof that the key never reaches a log line or a database row.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as revealPOST } from "@/app/api/account/licenses/[id]/reveal/route";
import { RATE_LIMITS } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { log, setLogSink, type LogSink } from "@/lib/log";
import { INCORRECT_PASSWORD_MESSAGE, REVEAL_REVOKED_MESSAGE } from "@/lib/licensing/reveal";
import { bodyOf, call, errorOf, makeCatalog, makeLicense, makeMember, PASSWORD, signIn, type Catalog, type Member } from "./license-actions-fixtures";

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) } : undefined),
    set: (name: string, value: string, options: { maxAge?: number } = {}) => {
      if (options.maxAge === 0 || value === "") jar.delete(name);
      else jar.set(name, value);
    },
  }),
  headers: async () => new Headers(),
}));

let catalog: Catalog;
let owner: Member;
beforeAll(async () => {
  catalog = await makeCatalog();
});
beforeEach(async () => {
  owner = await makeMember();
  await signIn(jar, owner);
});
afterEach(() => {
  vi.restoreAllMocks();
  setLogSink(null);
});

const reveal = (licenseId: string, body: unknown = { password: PASSWORD }, opts: { csrf?: boolean; origin?: string } = {}) =>
  call(jar, revealPOST, `/api/account/licenses/${licenseId}/reveal`, { method: "POST", body, params: { id: licenseId }, ...opts });

async function revealedEvents(licenseId: string) {
  return db.licenseEvent.count({ where: { licenseId, type: "key_revealed" } });
}

describe("reveal", () => {
  it("returns the full key for 60 s to an owner with the right password and records it without the key", async () => {
    const { license, key } = await makeLicense(catalog, { accountId: owner.accountId });
    const before = Date.now();
    const res = await reveal(license.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await bodyOf(res);
    expect(body.key).toBe(key);
    const hideAt = Date.parse(String(body.hideAt));
    expect(hideAt - before).toBeGreaterThanOrEqual(59_000);
    expect(hideAt - Date.now()).toBeLessThanOrEqual(60_000);
    expect(Object.keys(body).sort()).toEqual(["hideAt", "key"]);

    const events = await db.licenseEvent.findMany({ where: { licenseId: license.id } });
    expect(events).toEqual([expect.objectContaining({ type: "key_revealed", actor: "Priya Sharma", detail: null })]);
    const activity = await db.accountActivity.findMany({ where: { accountId: owner.accountId } });
    expect(activity).toEqual([
      expect.objectContaining({ actorId: owner.user.id, actorName: "Priya Sharma", action: "Revealed license key", target: license.id, kind: "security" }),
    ]);
  });

  it("lets a Technical contact reveal; Viewer and Billing get 403 without spending an attempt", async () => {
    const { license, key } = await makeLicense(catalog, { accountId: owner.accountId });
    const technical = await makeMember({ accountId: owner.accountId, role: "TECHNICAL", name: "Kavya Desai" });
    await signIn(jar, technical);
    const ok = await reveal(license.id);
    expect(ok.status).toBe(200);
    expect((await bodyOf(ok)).key).toBe(key);

    for (const role of ["VIEWER", "BILLING"] as const) {
      const member = await makeMember({ accountId: owner.accountId, role });
      await signIn(jar, member);
      const res = await reveal(license.id);
      expect(res.status).toBe(403);
      expect(errorOf(await bodyOf(res)).code).toBe("forbidden");
      expect(await db.rateLimitBucket.count({ where: { key: RATE_LIMITS.keyReveal(member.user.id).key } })).toBe(0);
    }
    expect(await revealedEvents(license.id)).toBe(1);
  });

  it("answers 422 incorrect_password with the portal copy and records nothing", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const res = await reveal(license.id, { password: "Wrong1horse" });
    expect(res.status).toBe(422);
    const error = errorOf(await bodyOf(res));
    expect(error).toMatchObject({ code: "incorrect_password", message: INCORRECT_PASSWORD_MESSAGE });
    expect(error.fieldErrors).toEqual({ password: [INCORRECT_PASSWORD_MESSAGE] });
    expect(await revealedEvents(license.id)).toBe(0);
    expect(await db.accountActivity.count({ where: { accountId: owner.accountId } })).toBe(0);
  });

  it("allows 5 password checks per 15 minutes; the 6th is refused even with the right password", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    for (let i = 0; i < 5; i++) expect((await reveal(license.id, { password: `Wrong${i}horse` })).status).toBe(422);
    const res = await reveal(license.id);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(14 * 60);
    expect(errorOf(await bodyOf(res))).toMatchObject({ code: "too_many_attempts", message: "Too many attempts. Try again in 15 minutes." });
    expect(await revealedEvents(license.id)).toBe(0);
  });

  it("clears the counter after a successful reveal", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    for (let i = 0; i < 4; i++) expect((await reveal(license.id, { password: "Wrong1horse" })).status).toBe(422);
    expect((await reveal(license.id)).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await reveal(license.id, { password: "Wrong1horse" })).status).toBe(422);
    expect((await reveal(license.id)).status).toBe(429);
  });

  it("counts before checking: 8 concurrent wrong guesses run at most 5 password checks", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    const results = await Promise.all(Array.from({ length: 8 }, () => reveal(license.id, { password: "Wrong1horse" })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 422)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
  });

  it("refuses revoked licenses with 409 before any password check", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId, status: "REVOKED" });
    const res = await reveal(license.id);
    expect(res.status).toBe(409);
    expect(errorOf(await bodyOf(res))).toMatchObject({ code: "license_revoked", message: REVEAL_REVOKED_MESSAGE });
    expect(await db.rateLimitBucket.count({ where: { key: RATE_LIMITS.keyReveal(owner.user.id).key } })).toBe(0);
  });

  it("still reveals suspended and expired keys (only revoked ones are refused)", async () => {
    const suspended = await makeLicense(catalog, { accountId: owner.accountId, status: "SUSPENDED" });
    const expired = await makeLicense(catalog, { accountId: owner.accountId, expiresAt: new Date(Date.now() - 86_400_000) });
    expect((await bodyOf(await reveal(suspended.license.id))).key).toBe(suspended.key);
    expect((await bodyOf(await reveal(expired.license.id))).key).toBe(expired.key);
  });

  it("answers 404 for another account's license, an unclaimed guest license, unknown and malformed ids", async () => {
    const stranger = await makeMember({ name: "Other Owner" });
    const theirs = await makeLicense(catalog, { accountId: stranger.accountId });
    const guest = await makeLicense(catalog, { accountId: null });
    for (const id of [theirs.license.id, guest.license.id, "LIC-T00000000", "not-a-license"]) {
      const res = await reveal(id);
      expect(res.status, id).toBe(404);
      const body = await bodyOf(res);
      expect(JSON.stringify(body)).not.toContain(theirs.key);
    }
    expect(await revealedEvents(theirs.license.id)).toBe(0);
  });

  it("requires CSRF, the same origin, a verified email and a session", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    expect(errorOf(await bodyOf(await reveal(license.id, undefined, { csrf: false }))).code).toBe("csrf_failed");
    expect(errorOf(await bodyOf(await reveal(license.id, undefined, { origin: "https://evil.example" }))).code).toBe("csrf_failed");

    const unverified = await makeMember({ verified: false });
    const own = await makeLicense(catalog, { accountId: unverified.accountId });
    await signIn(jar, unverified);
    const res = await reveal(own.license.id);
    expect(res.status).toBe(403);
    expect(errorOf(await bodyOf(res)).code).toBe("email_unverified");

    jar.clear();
    expect((await reveal(license.id)).status).toBe(401);
  });

  it("rejects unknown body keys and missing passwords with 422", async () => {
    const { license } = await makeLicense(catalog, { accountId: owner.accountId });
    expect((await reveal(license.id, { password: PASSWORD, accountId: "acc" })).status).toBe(422);
    expect((await reveal(license.id, {})).status).toBe(422);
    expect(await revealedEvents(license.id)).toBe(0);
  });

  it("never writes the key to a log line (raw fields or output) or to any database row", async () => {
    const lines: string[] = [];
    const sink: LogSink = (_level, line) => lines.push(line);
    setLogSink(sink);
    const raw: unknown[] = [];
    for (const level of ["info", "warn", "error"] as const) {
      const original = log[level];
      vi.spyOn(log, level).mockImplementation((event, fields) => {
        raw.push([event, fields]);
        original(event, fields);
      });
    }

    const { license, key } = await makeLicense(catalog, { accountId: owner.accountId });
    await reveal(license.id, { password: "Wrong1horse" });
    const res = await reveal(license.id);
    expect((await bodyOf(res)).key).toBe(key);

    // The route logged something (so the spies are wired), but never the key, with or without dashes.
    expect(raw.length).toBeGreaterThan(0);
    const forms = [key, key.replaceAll("-", ""), key.toLowerCase()];
    const rawText = JSON.stringify(raw);
    for (const form of forms) {
      expect(rawText).not.toContain(form);
      for (const line of lines) expect(line).not.toContain(form);
    }

    // Every table of the test schema, every row, every column (row-to-text).
    const tables = await db.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`;
    expect(tables.length).toBeGreaterThan(20);
    for (const { table_name: table } of tables) {
      expect(table).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
      const hits = await db.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM "${table}" t WHERE strpos(upper(t::text), $1) > 0 OR strpos(upper(t::text), $2) > 0`,
        key,
        key.replaceAll("-", ""),
      );
      expect(hits[0]?.n, table).toBe(0);
    }
  });
});
