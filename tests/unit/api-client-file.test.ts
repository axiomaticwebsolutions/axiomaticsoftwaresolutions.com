/**
 * apiFetch file bodies (lib/client/api.ts `file`, used by Admin > Settings > Branding uploads): the file is sent as the
 * raw body with Content-Type application/octet-stream, with the CSRF token like any mutation, and a 422 comes back as
 * an ApiClientError with its field errors.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, apiFetch } from "@/lib/client/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch with a file", () => {
  it("PUTs the bytes as application/octet-stream with the CSRF header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (url === "/api/csrf") return new Response(JSON.stringify({ token: "csrf-token" }), { status: 200 });
        return new Response(JSON.stringify({ slot: "favicon", changed: true }), { status: 200 });
      }),
    );
    const file = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    const res = await apiFetch<{ changed: boolean }>("/api/admin/settings/branding/favicon", { method: "PUT", file });
    expect(res.changed).toBe(true);
    const put = calls.find((c) => c.url !== "/api/csrf");
    expect(put?.init.method).toBe("PUT");
    expect(put?.init.body).toBe(file);
    expect((put?.init.headers as Record<string, string>)["content-type"]).toBe("application/octet-stream");
    expect((put?.init.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf-token");
  });

  it("defaults to POST for a file and surfaces 422 field errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/csrf"
          ? new Response(JSON.stringify({ token: "t" }), { status: 200 })
          : new Response(JSON.stringify({ error: { code: "validation_failed", message: "Fix it.", fieldErrors: { file: ["Upload a PNG, SVG or WebP file."] } } }), { status: 422 }),
      ),
    );
    const error = await apiFetch("/api/x", { file: new Blob(["x"]) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).fieldErrors.file).toEqual(["Upload a PNG, SVG or WebP file."]);
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe("POST");
  });
});
