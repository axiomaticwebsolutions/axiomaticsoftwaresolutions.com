import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clampTtl } from "@/lib/storage";
import { encodeStorageKeyPath, LocalStorageDriver, signLocalRequest, verifyLocalSignature } from "@/lib/storage/local";
import { S3StorageDriver } from "@/lib/storage/s3";
import { attachmentDisposition, isStorageKey, sanitizeDownloadName, StorageError } from "@/lib/storage/types";

const secret = "local-storage-test-secret-0123456789abcdef";
const now = new Date("2026-10-06T10:00:00.000Z");
const nowSec = now.getTime() / 1000;
const KEY = "releases/medical-billing/4.2.1/MedicalBilling-4.2.1-setup.exe";
let dir = "";
let driver: LocalStorageDriver;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "axs-storage-"));
  driver = new LocalStorageDriver({ dir, appUrl: "http://localhost:3000/", secret, now: () => now });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function parts(url: string) {
  const u = new URL(url);
  return { u, exp: u.searchParams.get("exp") ?? "", sig: u.searchParams.get("sig") ?? "" };
}

const at = (seconds: number) => new Date(now.getTime() + seconds * 1000);

describe("presignGet", () => {
  it("builds an app URL signed over GET|key|exp", async () => {
    const { url, expiresAt } = await driver.presignGet(KEY, { ttlSec: 600 });
    const { u, exp, sig } = parts(url);
    expect(`${u.origin}${u.pathname}`).toBe(`http://localhost:3000/api/dev/storage/${KEY}`);
    expect(Number(exp)).toBe(nowSec + 600);
    expect(expiresAt.getTime()).toBe(now.getTime() + 600_000);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(sig).toBe(signLocalRequest("GET", KEY, nowSec + 600, secret));
    expect(verifyLocalSignature("GET", KEY, exp, sig, now, { secret })).toBe(true);
    expect(verifyLocalSignature("get", KEY, Number(exp), sig, now, { secret })).toBe(true);
  });

  it("keeps key segments readable and carries an unsigned download name", async () => {
    await expect(driver.presignGet("a/b c", { ttlSec: 60 })).rejects.toThrow(StorageError);
    expect(encodeStorageKeyPath("a/b-c/d_e.f")).toBe("a/b-c/d_e.f");
    const named = await driver.presignGet(KEY, { ttlSec: 60, downloadName: "Setup 4.2.1.exe" });
    const { u, exp, sig } = parts(named.url);
    expect(u.searchParams.get("name")).toBe("Setup 4.2.1.exe");
    expect(verifyLocalSignature("GET", KEY, exp, sig, now, { secret })).toBe(true);
  });

  it("expires at exp and not a moment later", async () => {
    const { url } = await driver.presignGet(KEY, { ttlSec: 120 });
    const { exp, sig } = parts(url);
    expect(verifyLocalSignature("GET", KEY, exp, sig, at(119), { secret })).toBe(true);
    expect(verifyLocalSignature("GET", KEY, exp, sig, at(120), { secret })).toBe(false);
    expect(verifyLocalSignature("GET", KEY, exp, sig, at(3600), { secret })).toBe(false);
  });

  it("rejects tampering with the key, expiry, signature, method or secret", async () => {
    const { url } = await driver.presignGet(KEY, { ttlSec: 300 });
    const { exp, sig } = parts(url);
    const flipped = (sig.startsWith("a") ? "b" : "a") + sig.slice(1);
    expect(verifyLocalSignature("GET", `${KEY}.bak`, exp, sig, now, { secret })).toBe(false);
    expect(verifyLocalSignature("GET", KEY, String(Number(exp) + 60), sig, now, { secret })).toBe(false);
    expect(verifyLocalSignature("GET", KEY, exp, flipped, now, { secret })).toBe(false);
    expect(verifyLocalSignature("GET", KEY, exp, sig.toUpperCase(), now, { secret })).toBe(false);
    expect(verifyLocalSignature("GET", KEY, exp, sig.slice(0, 63), now, { secret })).toBe(false);
    expect(verifyLocalSignature("PUT", KEY, exp, sig, now, { secret, maxBytes: 10, contentType: "text/plain" })).toBe(false);
    expect(verifyLocalSignature("DELETE", KEY, exp, sig, now, { secret })).toBe(false);
    expect(verifyLocalSignature("GET", KEY, exp, sig, now, { secret: `${secret}x` })).toBe(false);
    expect(verifyLocalSignature("GET", KEY, `${exp}.0`, sig, now, { secret })).toBe(false);
    expect(verifyLocalSignature("GET", KEY, "-1", sig, now, { secret })).toBe(false);
  });

  it("rejects validly signed URLs that expire further out than any URL the driver issues", () => {
    const exp = nowSec + 3600;
    expect(verifyLocalSignature("GET", KEY, exp, signLocalRequest("GET", KEY, exp, secret), now, { secret })).toBe(false);
    const ok = nowSec + 600;
    expect(verifyLocalSignature("GET", KEY, ok, signLocalRequest("GET", KEY, ok, secret), now, { secret })).toBe(true);
  });
});

describe("presignPut", () => {
  it("binds the size cap and content type into the signature", async () => {
    const put = await driver.presignPut("tickets/T-3019/screenshot.png", { ttlSec: 300, contentType: "Image/PNG", maxBytes: 10_485_760 });
    expect(put.method).toBe("PUT");
    expect(put.headers).toEqual({ "Content-Type": "image/png" });
    const { u, exp, sig } = parts(put.url);
    const maxBytes = Number(u.searchParams.get("max"));
    const contentType = u.searchParams.get("ct") ?? "";
    expect({ maxBytes, contentType }).toEqual({ maxBytes: 10_485_760, contentType: "image/png" });
    const key = "tickets/T-3019/screenshot.png";
    expect(verifyLocalSignature("PUT", key, exp, sig, now, { secret, maxBytes, contentType })).toBe(true);
    expect(verifyLocalSignature("PUT", key, exp, sig, now, { secret, maxBytes: maxBytes * 10, contentType })).toBe(false);
    expect(verifyLocalSignature("PUT", key, exp, sig, now, { secret, maxBytes, contentType: "text/html" })).toBe(false);
    expect(verifyLocalSignature("PUT", key, exp, sig, now, { secret })).toBe(false);
    expect(verifyLocalSignature("GET", key, exp, sig, now, { secret })).toBe(false);
  });

  it("validates content type and size", async () => {
    await expect(driver.presignPut(KEY, { ttlSec: 60, contentType: "text/html; charset=utf-8", maxBytes: 10 })).rejects.toThrow(StorageError);
    await expect(driver.presignPut(KEY, { ttlSec: 60, contentType: "image/png", maxBytes: 0 })).rejects.toThrow(StorageError);
  });
});

describe("TTL", () => {
  it("never signs for more than 600 seconds or less than 1", async () => {
    for (const ttlSec of [0, -5, 601, 3600, 1.5]) {
      await expect(driver.presignGet(KEY, { ttlSec })).rejects.toThrow(StorageError);
    }
    await expect(driver.presignGet(KEY, { ttlSec: 1 })).resolves.toMatchObject({ expiresAt: at(1) });
  });

  it("clampTtl takes the minimum of the request, the env limit and 600 s", () => {
    expect(clampTtl(3600, 600)).toBe(600);
    expect(clampTtl(300, 600)).toBe(300);
    expect(clampTtl(900, 120)).toBe(120);
    expect(clampTtl(12.7, 600)).toBe(12);
    expect(clampTtl(0, 600)).toBe(1);
    expect(clampTtl(-30, 600)).toBe(1);
    expect(clampTtl(Number.POSITIVE_INFINITY, 600)).toBe(600);
    expect(clampTtl(500, 10_000)).toBe(500);
    expect(clampTtl(10_000, 10_000)).toBe(600);
    expect(() => clampTtl(Number.NaN, 600)).toThrow(RangeError);
  });
});

describe("keys and files", () => {
  it("accepts only safe keys", () => {
    for (const key of [KEY, "a", "tickets/T-3019/a_b.c-d.png"]) expect(isStorageKey(key)).toBe(true);
    const bad = ["", "/abs", "a//b", "a/../b", "../etc/passwd", ".hidden", "a/.b", "a/b/", "a b", `a${"\x5C"}b`, "a/b?c", "x".repeat(513)];
    for (const key of bad) expect(isStorageKey(key)).toBe(false);
    expect(() => driver.pathFor("../escape")).toThrow(StorageError);
    expect(driver.pathFor("a/b.txt")).toBe(path.join(path.resolve(dir), "a", "b.txt"));
  });

  it("writes objects and reports their size", async () => {
    await driver.putObject("releases/test/setup.bin", Buffer.from("hello installer"), "application/octet-stream");
    expect(await driver.head("releases/test/setup.bin")).toEqual({ sizeBytes: 15 });
    await driver.putObject("releases/test/setup.bin", Buffer.alloc(3), "application/octet-stream");
    expect(await driver.head("releases/test/setup.bin")).toEqual({ sizeBytes: 3 });
    expect(await driver.head("releases/test/missing.bin")).toBeNull();
    expect(await driver.head("releases/test")).toBeNull();
    expect(await driver.head("releases/test/setup.bin/deeper")).toBeNull();
  });

  it("deletes objects; a missing object is not an error", async () => {
    await driver.putObject("uploads/acct/x/a.txt", Buffer.from("abc"), "text/plain");
    await driver.delete("uploads/acct/x/a.txt");
    expect(await driver.head("uploads/acct/x/a.txt")).toBeNull();
    await expect(driver.delete("uploads/acct/x/a.txt")).resolves.toBeUndefined();
    await expect(driver.delete("../escape")).rejects.toThrow(StorageError);
  });
});

describe("attachmentDisposition", () => {
  it("adds an ASCII fallback and an RFC 5987 UTF-8 name", () => {
    expect(attachmentDisposition("Medical Billing 4.2.1.exe")).toBe(
      "attachment; filename=\"Medical Billing 4.2.1.exe\"; filename*=UTF-8''Medical%20Billing%204.2.1.exe",
    );
    expect(attachmentDisposition("बिलिंग (v4)*.exe")).toBe(
      "attachment; filename=\"______ (v4)*.exe\"; filename*=UTF-8''%E0%A4%AC%E0%A4%BF%E0%A4%B2%E0%A4%BF%E0%A4%82%E0%A4%97%20%28v4%29%2A.exe",
    );
  });

  it("strips quotes, slashes, control characters and leading dots", () => {
    expect(sanitizeDownloadName(`..${"\x5C"}evil"/name\r\n.exe`)).toBe("evilname.exe");
    expect(sanitizeDownloadName("   ")).toBe("download");
    expect(attachmentDisposition("a;b%c.txt")).toBe("attachment; filename=\"a_b_c.txt\"; filename*=UTF-8''a%3Bb%25c.txt");
  });
});

// The S3 driver signs locally (no network), so its URL shape is checked here alongside the local driver.
describe("S3 driver presigning", () => {
  const s3 = new S3StorageDriver({
    bucket: "axiomatic-installers",
    region: "ap-south-1",
    accessKeyId: "AKIAEXAMPLEKEY",
    secretAccessKey: "example-secret-access-key",
    now: () => now,
  });

  it("presigns a GET with the attachment name and the requested lifetime", async () => {
    const { url, expiresAt } = await s3.presignGet(KEY, { ttlSec: 600, downloadName: "Medical Billing 4.2.1.exe" });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(`https://axiomatic-installers.s3.ap-south-1.amazonaws.com/${KEY}`);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("600");
    expect(u.searchParams.get("response-content-disposition")).toBe(attachmentDisposition("Medical Billing 4.2.1.exe"));
    expect(expiresAt).toEqual(at(600));
    await expect(s3.presignGet(KEY, { ttlSec: 601 })).rejects.toThrow(StorageError);
  });

  it("presigns a PUT that signs the content type and the exact length, without checksum parameters", async () => {
    const put = await s3.presignPut("tickets/T-3019/a.png", { ttlSec: 300, contentType: "image/png", maxBytes: 1024 });
    const u = new URL(put.url);
    // S3 refuses a PUT whose Content-Length differs from the signed one, so no other size can be stored.
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host");
    expect([...u.searchParams.keys()].some((k) => k.toLowerCase().includes("checksum"))).toBe(false);
    // Content-Length is a forbidden header for browsers (they send the File's size), so it is not handed back.
    expect(put).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/png" }, expiresAt: at(300) });
    expect(Object.keys(put.headers)).toEqual(["Content-Type"]);
    const other = await s3.presignPut("tickets/T-3019/a.png", { ttlSec: 300, contentType: "image/png", maxBytes: 1025 });
    expect(new URL(other.url).searchParams.get("X-Amz-Signature")).not.toBe(u.searchParams.get("X-Amz-Signature"));
  });

  it("deletes an object with DeleteObject and refuses invalid keys", async () => {
    const sent: { name: string; input: unknown }[] = [];
    const client = { send: async (command: { constructor: { name: string }; input: unknown }) => { sent.push({ name: command.constructor.name, input: command.input }); return {}; } };
    const fake = new S3StorageDriver({ bucket: "axiomatic-installers", region: "ap-south-1", accessKeyId: "AKIAEXAMPLEKEY", secretAccessKey: "example-secret-access-key" }, client as never);
    await fake.delete("uploads/acct/x/a.png");
    expect(sent).toEqual([{ name: "DeleteObjectCommand", input: { Bucket: "axiomatic-installers", Key: "uploads/acct/x/a.png" } }]);
    await expect(fake.delete("../escape")).rejects.toThrow(StorageError);
    expect(sent).toHaveLength(1);
  });
});
