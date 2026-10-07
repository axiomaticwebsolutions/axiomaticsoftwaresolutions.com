/**
 * Portal license and device queries stay on indexes as DeviceActivation grows (decisions.md Phase 4 fix pass,
 * docs/scaling.md "Database indexes"). Prisma's `_count` of a license's devices compiles to a GROUP BY over the whole
 * DeviceActivation table joined afterwards (a sequential scan and a hash aggregate on every list request); the read
 * models now count devices for the listed licenses only.
 *
 * The test loads 5,000 accounts, 20,000 licenses and 40,000 devices (half active) into the run's schema, ANALYZEs them,
 * captures the SQL that listAccountLicenses / getAccountLicenseDetail / listAccountDevices / countActiveDevices send,
 * and EXPLAINs every statement that reads DeviceActivation: none may scan the table (or a whole index) unbounded. A
 * control query with the old `_count` shape must be flagged, so the check is known to be sensitive. The rows are
 * deleted afterwards.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getAccountLicenseDetail, listAccountDevices, listAccountLicenses } from "@/lib/licensing/account";
import { countActiveDevices } from "@/lib/licensing/device-limit";
import { capturingClient, explain, unboundedScans, type CapturedQuery } from "../support/query-capture";
import { freshProductCode } from "../support/product-codes";

const tag = randomBytes(3).toString("hex");
const ACCOUNTS = 5_000;
const LICENSES = 20_000;
const DEVICES = 40_000;
const accountId = `pqp-${tag}-1`;
const licenseId = (n: number) => `LIC-PQP${tag.toUpperCase()}${n}`;
const now = new Date();
const capture = capturingClient();

beforeAll(async () => {
  const category = await db.category.create({ data: { id: `pqp-cat-${tag}`, name: "Plans", tone: "sage", icon: "receipt_long" } });
  const product = await db.product.create({
    data: {
      id: `pqp-prod-${tag}`,
      code: await freshProductCode(),
      name: `Plan test ${tag}`,
      shortName: `PQP ${tag}`,
      tagline: "Test",
      summary: "Test",
      icon: "receipt_long",
      categoryId: category.id,
      platforms: ["windows"],
      status: "PUBLISHED",
      content: {},
      relatedIds: [],
    },
  });
  const plan = await db.plan.create({
    data: { id: `pqp-plan-${tag}`, productId: product.id, type: "ANNUAL", name: "Annual", pricePaise: 100_000, includes: [], deviceLimit: 3 },
  });
  await db.$executeRawUnsafe(
    `INSERT INTO "BusinessAccount" ("id", "legalName", "createdAt", "updatedAt")
     SELECT 'pqp-' || $1 || '-' || g, 'Plan store ' || g, now(), now() FROM generate_series(1, ${ACCOUNTS}) g`,
    tag,
  );
  // 4 licenses per account; account 1 holds licenses 5000, 10000, 15000 and 20000.
  await db.$executeRawUnsafe(
    `INSERT INTO "License" ("id", "accountId", "productId", "planId", "keyHash", "keyCiphertext", "keyLast4", "status", "issuedAt",
                            "expiresAt", "updatesUntil", "deviceLimit", "selfServiceResets", "resetsYear", "autoRenew")
     SELECT 'LIC-PQP' || upper($1) || g, 'pqp-' || $1 || '-' || ((g % ${ACCOUNTS}) + 1), $2, $3, md5($1 || 'k' || g), 'v1.t.t.t', 'TEST',
            'ACTIVE', now(), now() + interval '300 days', now() + interval '300 days', 3, 0, 2026, false
     FROM generate_series(1, ${LICENSES}) g`,
    tag,
    product.id,
    plan.id,
  );
  // Two devices per license: device g belongs to license (g % 20000) + 1; the first 20,000 are active, the rest
  // deactivated, so every license has exactly one active device.
  await db.$executeRawUnsafe(
    `INSERT INTO "DeviceActivation" ("id", "licenseId", "fingerprint", "name", "os", "activatedAt", "lastSeenAt", "deactivatedAt")
     SELECT 'pqd-' || $1 || '-' || g, 'LIC-PQP' || upper($1) || ((g % ${LICENSES}) + 1), md5($1 || 'f' || g), 'PC ' || g, 'Windows 11',
            now(), now(), CASE WHEN g > ${LICENSES} THEN now() ELSE NULL END
     FROM generate_series(1, ${DEVICES}) g`,
    tag,
  );
  await db.$executeRawUnsafe(`ANALYZE "BusinessAccount"`);
  await db.$executeRawUnsafe(`ANALYZE "License"`);
  await db.$executeRawUnsafe(`ANALYZE "DeviceActivation"`);
}, 120_000);

afterAll(async () => {
  await capture.client.$disconnect();
  await db.$executeRawUnsafe(`DELETE FROM "DeviceActivation" WHERE "id" LIKE 'pqd-' || $1 || '-%'`, tag);
  await db.$executeRawUnsafe(`DELETE FROM "License" WHERE "id" LIKE 'LIC-PQP' || upper($1) || '%'`, tag);
  await db.$executeRawUnsafe(`DELETE FROM "BusinessAccount" WHERE "id" LIKE 'pqp-' || $1 || '-%'`, tag);
  await db.$executeRawUnsafe(`ANALYZE "DeviceActivation"`);
  await db.$executeRawUnsafe(`ANALYZE "License"`);
}, 120_000);

/** Runs `fn` on the capturing client and returns the statements it sent that read DeviceActivation. */
async function deviceQueriesOf(fn: () => Promise<unknown>): Promise<CapturedQuery[]> {
  capture.queries.length = 0;
  await fn();
  return capture.queries.filter((q) => q.sql.includes('"DeviceActivation"'));
}

async function expectIndexBounded(queries: CapturedQuery[]): Promise<void> {
  expect(queries.length).toBeGreaterThan(0);
  for (const query of queries) {
    const plan = await explain(db, query);
    expect({ sql: query.sql, unbounded: unboundedScans(plan, "DeviceActivation").map((n) => n["Node Type"]) }).toEqual({
      sql: query.sql,
      unbounded: [],
    });
  }
}

type LicenseList = Awaited<ReturnType<typeof listAccountLicenses>>;
type Fleet = Awaited<ReturnType<typeof listAccountDevices>>;
const scope = { accountId, role: "OWNER" as const };

describe("portal license and device queries at scale", () => {
  it("control: the old _count shape scans the whole DeviceActivation table (the check is sensitive)", async () => {
    const queries = await deviceQueriesOf(() =>
      capture.client.license.findMany({
        where: { accountId },
        select: { id: true, _count: { select: { devices: { where: { deactivatedAt: null } } } } },
      }),
    );
    expect(queries).toHaveLength(1);
    const plan = await explain(db, queries[0] as CapturedQuery);
    expect(unboundedScans(plan, "DeviceActivation").length).toBeGreaterThan(0);
  });

  it("listAccountLicenses counts devices of the listed licenses only, with the right numbers", async () => {
    const query = { status: "all" as const, product: "all", q: "", sort: { key: "expiry" as const, dir: 1 as const } };
    const box: { list?: LicenseList } = {};
    const queries = await deviceQueriesOf(async () => {
      box.list = await listAccountLicenses(capture.client, scope, query, now);
    });
    await expectIndexBounded(queries);
    const rows = box.list?.licenses ?? [];
    expect(rows.map((r) => r.id).sort()).toEqual([licenseId(10000), licenseId(15000), licenseId(20000), licenseId(5000)].sort());
    expect(rows.map((r) => r.devicesUsed)).toEqual([1, 1, 1, 1]);
  });

  it("getAccountLicenseDetail and listAccountDevices stay on indexes", async () => {
    const detail = await deviceQueriesOf(() => getAccountLicenseDetail(capture.client, scope, licenseId(5000), now));
    await expectIndexBounded(detail);
    const box: { fleet?: Fleet } = {};
    const queries = await deviceQueriesOf(async () => {
      box.fleet = await listAccountDevices(capture.client, scope, { status: "all", location: "all", q: "" }, now);
    });
    await expectIndexBounded(queries);
    expect(box.fleet?.stats).toMatchObject({ activeDevices: 4, freeSlots: 8, staleDevices: 0 });
    expect(box.fleet?.devices).toHaveLength(8);
  });

  it("countActiveDevices uses the licenseId index for a page of licenses", async () => {
    // 50 of 20,000 licenses keeps the share of the table realistic; a full page of 1,000 ids is 5 % of this small
    // table, where a sequential scan is the right plan (at 25 lakh licenses it is 0.04 % and stays on the index).
    const ids = Array.from({ length: 50 }, (_, i) => licenseId(i + 1));
    const box: { counts?: Map<string, number> } = {};
    const queries = await deviceQueriesOf(async () => {
      box.counts = await countActiveDevices(capture.client, ids);
    });
    await expectIndexBounded(queries);
    expect(box.counts?.size).toBe(50);
    expect([...(box.counts?.values() ?? [])].every((n) => n === 1)).toBe(true);
    expect((await countActiveDevices(db, ["LIC-NONE", "LIC-NONE"])).get("LIC-NONE")).toBe(0);
  });
});
