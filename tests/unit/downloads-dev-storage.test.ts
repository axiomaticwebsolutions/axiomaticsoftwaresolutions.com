/**
 * GET /api/dev/storage/<key>?exp=&sig= (development stand-in for S3 presigned GETs): signature and expiry checks,
 * path traversal and absolute keys, streaming headers, and the production / non-local 404s.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type * as EnvModule from "@/lib/env";
import { setStorage, type StorageDriver } from "@/lib/storage";
import { LocalStorageDriver, signLocalRequest } from "@/lib/storage/local";

const env = vi.hoisted(() => ({
  value: {
    NODE_ENV: "test",
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: "",
    SESSION_SECRET: "dev-storage-route-test-secret-0123456789abcdef",
    APP_URL: "http://localhost:3000",
    DOWNLOAD_LINK_TTL_SECONDS: 600,
    TRUSTED_PROXY_HOPS: 0,
  },
}));
vi.mock("@/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  getEnv: () => env.value,
}));

const { GET } = await import("@/app/api/dev/storage/[...key]/route");

const KEY = "releases/test-product/1.0.0/TestProduct-1.0.0-setup.exe";
const CONTENT = "SAMPLE installer placeholder\nfor tests\n";
let dir = "";
let driver: LocalStorageDriver;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "axs-dev-storage-"));
  env.value.STORAGE_LOCAL_DIR = dir;
  driver = new LocalStorageDriver({ dir, appUrl: env.value.APP_URL, secret: env.value.SESSION_SECRET });
  await driver.putObject(KEY, Buffer.from(CONTENT, "utf8"), "application/octet-stream");
  setStorage(driver);
});

afterEach(() => {
  vi.unstubAllEnvs();
  env.value.STORAGE_DRIVER = "local";
});

afterAll(async () => {
  setStorage(null);
  await rm(dir, { recursive: true, force: true });
});

/** Calls the route for a URL the way Next does: the catch-all segments come decoded from the path. */
async function get(url: string, segments?: string[]): Promise<Response> {
  const u = new URL(url);
  const key = segments ?? u.pathname.replace(/^[/]api[/]dev[/]storage[/]/, "").split("/").map(decodeURIComponent);
  return GET(new NextRequest(u), { params: Promise.resolve({ key }) });
}

async function code(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

describe("GET /api/dev/storage/[...key]", () => {
  it("streams the object for a valid link, as an attachment that is never cached", async () => {
    const { url } = await driver.presignGet(KEY, { ttlSec: 600, downloadName: "Test Product 1.0.0 setup.exe" });
    const res = await get(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CONTENT);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(CONTENT)));
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename=\"Test Product 1.0.0 setup.exe\"; filename*=UTF-8''Test%20Product%201.0.0%20setup.exe",
    );
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("falls back to the key's file name and sanitises a hostile name", async () => {
    const plain = await driver.presignGet(KEY, { ttlSec: 60 });
    expect((await get(plain.url)).headers.get("content-disposition")).toContain('filename="TestProduct-1.0.0-setup.exe"');
    const hostile = await driver.presignGet(KEY, { ttlSec: 60, downloadName: 'evil"\r\nSet-Cookie: x=1/..' });
    const disposition = (await get(hostile.url)).headers.get("content-disposition") ?? "";
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition.startsWith('attachment; filename="evilSet-Cookie: x=1..";')).toBe(true);
  });

  it("refuses tampered, expired and unsigned links with 403", async () => {
    const { url } = await driver.presignGet(KEY, { ttlSec: 60 });
    const tampered = new URL(url);
    const sig = tampered.searchParams.get("sig") ?? "";
    tampered.searchParams.set("sig", `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`);
    expect([(await get(tampered.toString())).status]).toEqual([403]);

    const longer = new URL(url);
    longer.searchParams.set("exp", String(Number(longer.searchParams.get("exp")) + 60));
    const longerRes = await get(longer.toString());
    expect([longerRes.status, await code(longerRes)]).toEqual([403, "invalid_link"]);

    const past = new LocalStorageDriver({ dir, appUrl: env.value.APP_URL, secret: env.value.SESSION_SECRET, now: () => new Date(Date.now() - 3_600_000) });
    const expired = await past.presignGet(KEY, { ttlSec: 600 });
    expect((await get(expired.url)).status).toBe(403);

    expect((await get(`${env.value.APP_URL}/api/dev/storage/${KEY}`)).status).toBe(403);
    const otherKey = await driver.presignGet("releases/test-product/1.0.0/other.exe", { ttlSec: 60 });
    const swapped = new URL(url);
    swapped.searchParams.set("sig", new URL(otherKey.url).searchParams.get("sig") ?? "");
    expect((await get(swapped.toString())).status).toBe(403);
  });
});

describe("keys and availability", () => {
  const exp = () => Math.floor(Date.now() / 1000) + 300;
  /** A correctly signed URL for any key string, as someone holding the secret could build it. */
  const signed = (key: string) => {
    const e = exp();
    return `${env.value.APP_URL}/api/dev/storage/x?exp=${e}&sig=${signLocalRequest("GET", key, e, env.value.SESSION_SECRET)}`;
  };

  it.each([
    ["parent segments", ["..", "..", "package.json"]],
    ["a dot segment", ["releases", ".", "x.exe"]],
    ["an absolute key", ["", "etc", "passwd"]],
    ["a drive letter", ["C:", "Windows", "win.ini"]],
    ["a backslash", ["releases", "..\x5C..\x5Cpackage.json"]],
    ["a hidden temp file", ["releases", ".x.tmp"]],
    ["no key", []],
  ])("answers 404 for %s, even with a valid signature", async (_label, segments) => {
    const res = await get(signed(segments.join("/")), segments);
    expect(res.status).toBe(404);
  });

  it("answers 404 for a missing object behind a valid link", async () => {
    const { url } = await driver.presignGet("releases/test-product/9.9.9/missing.exe", { ttlSec: 60 });
    expect((await get(url)).status).toBe(404);
  });

  it("answers 404 when the effective storage driver is not local", async () => {
    const { url } = await driver.presignGet(KEY, { ttlSec: 60 });
    setStorage({ ...driver, kind: "s3" } as unknown as StorageDriver);
    try {
      expect((await get(url)).status).toBe(404);
    } finally {
      setStorage(driver);
    }
  });

  it("answers 404 in production", async () => {
    const { url } = await driver.presignGet(KEY, { ttlSec: 60 });
    vi.stubEnv("NODE_ENV", "production");
    const res = await get(url);
    expect(res.status).toBe(404);
    expect(await code(res)).toBe("not_found");
  });
});
