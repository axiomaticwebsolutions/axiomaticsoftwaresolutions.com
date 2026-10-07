/**
 * lib/downloads/issue.ts directly: the TTL cap, storage failures (nothing recorded), and the activity entry for a
 * guest download of an order that was later claimed into an account.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { issueDownload } from "@/lib/downloads/issue";
import type { StorageDriver } from "@/lib/storage";
import { freshProductCode } from "../support/product-codes";

const tag = randomBytes(3).toString("hex");
let seq = 0;
const uniq = (prefix: string) => `${prefix}-${tag}-${++seq}`;
const DAY = 86_400_000;

const calls: { key: string; ttlSec: number; downloadName?: string }[] = [];
const recording: StorageDriver = {
  kind: "s3",
  async presignGet(key, opts) {
    calls.push({ key, ...opts });
    const expiresAt = new Date(Math.floor(Date.now() / 1000) * 1000 + opts.ttlSec * 1000);
    return { url: `https://bucket.example/${key}?X-Amz-Expires=${opts.ttlSec}`, expiresAt };
  },
  presignPut: async () => {
    throw new Error("unused");
  },
  head: async () => null,
  delete: async () => undefined,
  putObject: async () => undefined,
};
const broken: StorageDriver = { ...recording, presignGet: async () => Promise.reject(new Error("credentials expired")) };

const f = {} as { fileId: string; accountId: string; orderId: string; licenseId: string };

beforeAll(async () => {
  const category = await db.category.create({ data: { id: uniq("dicat"), name: "Test", tone: "sage", icon: "receipt_long" } });
  const productId = uniq("diprod");
  await db.product.create({
    data: {
      id: productId, code: await freshProductCode(), name: "Issue test", shortName: "Issue", tagline: "t", summary: "t",
      icon: "receipt_long", categoryId: category.id, platforms: ["windows"], status: "PUBLISHED", content: {}, relatedIds: [],
    },
  });
  const plan = await db.plan.create({ data: { id: uniq("diplan"), productId, type: "ANNUAL", name: "Annual", pricePaise: 1, includes: [], deviceLimit: 1 } });
  const release = await db.release.create({ data: { productId, version: "7.1.0", status: "PUBLISHED", releasedAt: new Date(Date.now() - DAY), notes: [] } });
  f.fileId = (
    await db.releaseFile.create({
      data: { releaseId: release.id, platform: "windows", fileName: "Issue-7.1.0-setup.exe", storageKey: `releases/${productId}/7.1.0/Issue-7.1.0-setup.exe`, sizeBytes: BigInt(1024), sha256: "0".repeat(64) },
    })
  ).id;
  f.accountId = (await db.businessAccount.create({ data: { legalName: uniq("Store") } })).id;
  f.orderId = (
    await db.order.create({
      data: { id: `AX-I${tag}`, accountId: f.accountId, email: `${uniq("o")}@example.test`, billing: {}, status: "PAID", subtotalPaise: 0, taxablePaise: 0, totalPaise: 0, placeOfSupply: "Maharashtra" },
    })
  ).id;
  f.licenseId = (
    await db.license.create({
      data: {
        id: uniq("LIC-I"), accountId: f.accountId, productId, planId: plan.id, orderId: f.orderId, keyHash: randomBytes(32).toString("hex"),
        keyCiphertext: "v1.t.t.t", keyLast4: "TEST", deviceLimit: 1, resetsYear: 2026, expiresAt: new Date(Date.now() + 300 * DAY), updatesUntil: new Date(Date.now() + 300 * DAY),
      },
    })
  ).id;
});

describe("issueDownload", () => {
  it("caps the link at 600 s and names the download after the file", async () => {
    const link = await issueDownload(db, {
      fileId: f.fileId, scope: { kind: "account", accountId: f.accountId }, eventUserId: uniq("user"), actorName: "Priya", ttlSec: 3600, storage: recording,
    });
    expect(link.ttlSec).toBe(600);
    expect(calls.at(-1)).toMatchObject({ ttlSec: 600, downloadName: "Issue-7.1.0-setup.exe" });
    expect(link.url.startsWith("https://bucket.example/releases/")).toBe(true);
    expect(link.sizeLabel).toBe("1 KB");
  });

  it("records nothing when the storage driver fails (503 download_unavailable)", async () => {
    const userId = uniq("user");
    await expect(
      issueDownload(db, { fileId: f.fileId, scope: { kind: "account", accountId: f.accountId }, eventUserId: userId, actorName: "Priya", ttlSec: 600, storage: broken }),
    ).rejects.toMatchObject({ status: 503, code: "download_unavailable" });
    expect(await db.downloadEvent.count({ where: { userId } })).toBe(0);
  });

  it("logs a guest download of a claimed order in that account's activity", async () => {
    await issueDownload(db, {
      fileId: f.fileId, scope: { kind: "order", orderId: f.orderId }, eventUserId: `guest:${f.orderId}`, actorName: "Guest (order link)", ttlSec: 600, storage: recording,
    });
    const event = await db.downloadEvent.findFirstOrThrow({ where: { userId: `guest:${f.orderId}` } });
    expect(event.licenseId).toBe(f.licenseId);
    const activity = await db.accountActivity.findMany({ where: { accountId: f.accountId, actorName: "Guest (order link)" } });
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ action: "Downloaded installer", target: "Issue v7.1.0", kind: "download", actorId: null });
  });
});
