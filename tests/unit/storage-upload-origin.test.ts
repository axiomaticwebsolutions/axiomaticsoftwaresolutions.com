import { afterEach, describe, expect, it, vi } from "vitest";
import { storageUploadOrigin, uploadOriginFor } from "@/lib/storage/upload-origin";

describe("storageUploadOrigin (CSP connect-src for presigned uploads)", () => {
  it("needs nothing for the local driver or an incomplete S3 configuration", () => {
    expect(storageUploadOrigin({})).toBeNull();
    expect(storageUploadOrigin({ STORAGE_DRIVER: "local", STORAGE_BUCKET: "axs-files", STORAGE_REGION: "ap-south-1" })).toBeNull();
    expect(storageUploadOrigin({ STORAGE_DRIVER: "s3", STORAGE_REGION: "ap-south-1" })).toBeNull();
    expect(storageUploadOrigin({ STORAGE_DRIVER: "s3", STORAGE_BUCKET: "axs-files" })).toBeNull();
    expect(storageUploadOrigin({ STORAGE_DRIVER: "s3", STORAGE_BUCKET: "Bad_Bucket", STORAGE_REGION: "ap-south-1" })).toBeNull();
    expect(storageUploadOrigin({ STORAGE_DRIVER: "s3", STORAGE_BUCKET: "axs-files", STORAGE_REGION: "ap south 1" })).toBeNull();
    expect(storageUploadOrigin({ STORAGE_DRIVER: "s3", STORAGE_BUCKET: "axs-files", STORAGE_ENDPOINT: "not a url" })).toBeNull();
    expect(storageUploadOrigin({ STORAGE_DRIVER: "s3", STORAGE_BUCKET: "axs-files", STORAGE_ENDPOINT: "ftp://files.example.com" })).toBeNull();
  });

  it("uses the virtual-hosted AWS origin by default", () => {
    expect(storageUploadOrigin({ STORAGE_DRIVER: "s3", STORAGE_BUCKET: "axs-files", STORAGE_REGION: "ap-south-1" })).toBe(
      "https://axs-files.s3.ap-south-1.amazonaws.com",
    );
  });

  it("uses the path-style origin when forced or when the bucket name has dots", () => {
    expect(storageUploadOrigin({ STORAGE_DRIVER: "s3", STORAGE_BUCKET: "axs-files", STORAGE_REGION: "ap-south-1", STORAGE_FORCE_PATH_STYLE: "true" })).toBe(
      "https://s3.ap-south-1.amazonaws.com",
    );
    expect(storageUploadOrigin({ STORAGE_DRIVER: "s3", STORAGE_BUCKET: "files.axiomatic.in", STORAGE_REGION: "ap-south-1" })).toBe(
      "https://s3.ap-south-1.amazonaws.com",
    );
  });

  it("follows a custom endpoint (R2, MinIO)", () => {
    const base = { STORAGE_DRIVER: "s3", STORAGE_BUCKET: "axs-files", STORAGE_REGION: "auto" };
    expect(storageUploadOrigin({ ...base, STORAGE_ENDPOINT: "https://acc123.r2.cloudflarestorage.com" })).toBe("https://axs-files.acc123.r2.cloudflarestorage.com");
    expect(storageUploadOrigin({ ...base, STORAGE_ENDPOINT: "http://127.0.0.1:9000/", STORAGE_FORCE_PATH_STYLE: "1" })).toBe("http://127.0.0.1:9000");
  });
});

describe("next.config.ts upload CSP", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  type HeaderEntry = { source: string; headers: { key: string; value: string }[] };
  const csp = (entry: HeaderEntry | undefined) => entry?.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";

  it("keeps the bucket out of the static policy, even with STORAGE_* set: middleware.ts adds the runtime origin on every page", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("STORAGE_BUCKET", "axs-files");
    vi.stubEnv("STORAGE_REGION", "ap-south-1");
    vi.resetModules();
    const { default: config } = await import("@/next.config");
    const list = (await config.headers?.()) as HeaderEntry[];
    expect(list[0]?.source).toBe("/:path*");
    expect(csp(list[0])).toMatch(/connect-src 'self'( ws:)?;/);
    expect(csp(list[0])).not.toContain("axs-files");
    // The runtime origin on every page (static and strict policy): tests/unit/security-csp.test.ts.
    expect(list.slice(1).every((e) => csp(e) === "")).toBe(true);
  });

  it("adds no upload entries for the local driver", async () => {
    vi.stubEnv("STORAGE_DRIVER", "local");
    vi.resetModules();
    const { default: config } = await import("@/next.config");
    const list = (await config.headers?.()) as HeaderEntry[];
    expect(list.map((e) => e.source)).toEqual(["/:path*", "/checkout", "/orders/:id"]);
  });
});

describe("uploadOriginFor (runtime storage configuration)", () => {
  it("builds one exact origin: virtual-hosted, path-style, dotted bucket, R2 endpoint, AWS without an endpoint", () => {
    expect(uploadOriginFor({ bucket: "axs-files", region: "ap-south-1", endpoint: null, forcePathStyle: false })).toBe("https://axs-files.s3.ap-south-1.amazonaws.com");
    expect(uploadOriginFor({ bucket: "axs-files", region: "ap-south-1", endpoint: null, forcePathStyle: true })).toBe("https://s3.ap-south-1.amazonaws.com");
    expect(uploadOriginFor({ bucket: "files.axiomatic.in", region: "ap-south-1", endpoint: null, forcePathStyle: false })).toBe("https://s3.ap-south-1.amazonaws.com");
    expect(uploadOriginFor({ bucket: "axs-files", region: "auto", endpoint: "https://acc123.r2.cloudflarestorage.com", forcePathStyle: true })).toBe(
      "https://acc123.r2.cloudflarestorage.com",
    );
    expect(uploadOriginFor({ bucket: "axs-files", region: "blr1", endpoint: "https://blr1.digitaloceanspaces.com", forcePathStyle: false })).toBe(
      "https://axs-files.blr1.digitaloceanspaces.com",
    );
  });

  it("returns null for a malformed bucket, region or endpoint, never a wildcard", () => {
    expect(uploadOriginFor({ bucket: "Bad_Bucket", region: "ap-south-1", endpoint: null, forcePathStyle: false })).toBeNull();
    expect(uploadOriginFor({ bucket: "axs-files", region: "ap south 1", endpoint: null, forcePathStyle: false })).toBeNull();
    expect(uploadOriginFor({ bucket: "axs-files", region: "auto", endpoint: "ftp://files.example.com", forcePathStyle: true })).toBeNull();
    expect(uploadOriginFor({ bucket: "axs-files", region: "auto", endpoint: "not a url", forcePathStyle: true })).toBeNull();
  });
});
