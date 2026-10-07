import { afterEach, describe, expect, it, vi } from "vitest";
import { storageUploadOrigin } from "@/lib/storage/upload-origin";

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

  it("allows the bucket origin in connect-src of the static policy on every path (Phase 7: in-app navigation keeps the first page's CSP)", async () => {
    vi.stubEnv("STORAGE_DRIVER", "s3");
    vi.stubEnv("STORAGE_BUCKET", "axs-files");
    vi.stubEnv("STORAGE_REGION", "ap-south-1");
    vi.resetModules();
    const { default: config } = await import("@/next.config");
    const list = (await config.headers?.()) as HeaderEntry[];
    expect(list[0]?.source).toBe("/:path*");
    expect(csp(list[0])).toMatch(/connect-src 'self'[^;]* https:\/\/axs-files\.s3\.ap-south-1\.amazonaws\.com/);
    // The strict policy of /account/* and /admin/* (middleware.ts) carries it too: tests/unit/security-csp.test.ts.
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
