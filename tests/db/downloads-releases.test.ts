/**
 * loadPublishedReleases (lib/downloads/releases.ts): stable channel only, newest = highest version (a hotfix for an
 * older line published later never becomes "latest"), at most `perProduct` per product, and every SQL statement
 * bounded (a LIMIT per product, then the chosen ids only).
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { loadPublishedReleases } from "@/lib/downloads/releases";
import { capturingClient } from "../support/query-capture";
import { freshProductCode } from "../support/product-codes";

const tag = randomBytes(3).toString("hex");
const DAY = 86_400_000;
const now = new Date();
const at = (days: number) => new Date(now.getTime() + days * DAY);
const ids = { a: `rel-a-${tag}`, b: `rel-b-${tag}` };
const capture = capturingClient();

async function product(id: string, categoryId: string) {
  await db.product.create({
    data: {
      id,
      code: await freshProductCode(),
      name: `Release test ${id}`,
      shortName: id,
      tagline: "Test",
      summary: "Test",
      icon: "receipt_long",
      categoryId,
      platforms: ["windows"],
      status: "PUBLISHED",
      content: {},
      relatedIds: [],
    },
  });
}

async function release(productId: string, version: string, releasedAt: Date | null, extra: { status?: "PUBLISHED" | "DRAFT"; channel?: string } = {}) {
  const row = await db.release.create({
    data: { productId, version, releasedAt, status: extra.status ?? "PUBLISHED", channel: extra.channel ?? "stable", notes: [`Notes ${version}`] },
  });
  await db.releaseFile.create({
    data: { releaseId: row.id, platform: "windows", fileName: `App-${version}.exe`, storageKey: `k/${tag}/${version}`, sizeBytes: BigInt(1024), sha256: "0".repeat(64) },
  });
}

beforeAll(async () => {
  const category = await db.category.create({ data: { id: `rel-cat-${tag}`, name: "Releases", tone: "sage", icon: "receipt_long" } });
  await product(ids.a, category.id);
  await product(ids.b, category.id);
  await release(ids.a, "1.0.0", at(-300));
  await release(ids.a, "2.0.0", at(-30));
  await release(ids.a, "1.9.1", at(-5)); // hotfix for the 1.x line, published after 2.0.0
  await release(ids.a, "2.1.0-beta.1", at(-2), { channel: "beta" });
  await release(ids.a, "2.2.0", at(5)); // scheduled
  await release(ids.a, "3.0.0", at(-1), { status: "DRAFT" });
  await release(ids.b, "1.0.0", at(-10));
});

afterAll(async () => {
  await capture.client.$disconnect();
});

describe("loadPublishedReleases", () => {
  it("returns stable, released releases per product, highest version first, with their files", async () => {
    const map = await loadPublishedReleases(db, [ids.a, ids.b, ids.a], now);
    expect(map.get(ids.a)?.map((r) => r.version)).toEqual(["2.0.0", "1.9.1", "1.0.0"]);
    expect(map.get(ids.b)?.map((r) => r.version)).toEqual(["1.0.0"]);
    expect(map.get(ids.a)?.[0]).toMatchObject({ notes: ["Notes 2.0.0"], files: [expect.objectContaining({ fileName: "App-2.0.0.exe", platform: "windows" })] });
    expect(JSON.stringify([...map.values()])).not.toContain(`k/${tag}`); // storage keys stay on the server
    expect((await loadPublishedReleases(db, [ids.a], now, 2)).get(ids.a)?.map((r) => r.version)).toEqual(["2.0.0", "1.9.1"]);
    expect((await loadPublishedReleases(db, [], now)).size).toBe(0);
  });

  it("bounds every statement in SQL: a LIMIT per product, then only the chosen release ids", async () => {
    capture.queries.length = 0;
    await loadPublishedReleases(capture.client, [ids.a, ids.b], now, 2);
    const releaseQueries = capture.queries.filter((q) => /FROM "[^"]+"\."Release"/.test(q.sql));
    expect(releaseQueries).toHaveLength(3);
    for (const q of releaseQueries.slice(0, 2)) expect(q.sql).toMatch(/LIMIT \$\d+/);
    expect(releaseQueries[2]?.sql).toMatch(/"Release"\."id" IN \(/);
  });
});
