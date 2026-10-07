import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadFile,
  errorFromBody,
  fileNameFromDisposition,
  safeFileName,
} from "@/components/account/orders/download";
import { ApiClientError } from "@/lib/client/api";
import { csvHeaders } from "@/lib/csv";

describe("fileNameFromDisposition", () => {
  it("prefers the RFC 5987 name, then the quoted one", () => {
    expect(fileNameFromDisposition(csvHeaders("orders.csv")["Content-Disposition"], "x.csv")).toBe("orders.csv");
    expect(fileNameFromDisposition(`attachment; filename="Invoice-AXS-26-27-1174.pdf"`, "x.pdf")).toBe("Invoice-AXS-26-27-1174.pdf");
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.csv; filename=\"resume.csv\"", "x")).toBe("résumé.csv");
    expect(fileNameFromDisposition("attachment; filename=plain.csv", "x")).toBe("plain.csv");
  });

  it("falls back when the header is missing or unusable", () => {
    expect(fileNameFromDisposition(null, "orders.csv")).toBe("orders.csv");
    expect(fileNameFromDisposition("attachment", "orders.csv")).toBe("orders.csv");
    expect(fileNameFromDisposition("attachment; filename*=UTF-8''%E0%A4%A; filename=\"ok.csv\"", "x")).toBe("ok.csv");
    expect(fileNameFromDisposition(`attachment; filename=""`, "orders.csv")).toBe("orders.csv");
  });

  it("never returns path separators or hidden names", () => {
    expect(fileNameFromDisposition(`attachment; filename="../../etc/passwd"`, "x")).toBe("-..-etc-passwd");
    expect(safeFileName(`a${String.fromCharCode(92)}b:c*?.csv`, "x")).toBe("ab-c--.csv");
    expect(safeFileName(`..${String.fromCharCode(0)}hidden`, "x")).toBe("hidden");
    expect(safeFileName("   ", "fallback.csv")).toBe("fallback.csv");
    expect(safeFileName("a".repeat(300), "x")).toHaveLength(120);
  });
});

describe("errorFromBody", () => {
  it("keeps the server's code, message and details", () => {
    const error = errorFromBody(429, { error: { code: "too_many_attempts", message: "Too many exports.", retryAfter: 60 } });
    expect(error).toBeInstanceOf(ApiClientError);
    expect([error.status, error.code, error.message, error.details.retryAfter]).toEqual([429, "too_many_attempts", "Too many exports.", 60]);
  });

  it("uses a generic message without an envelope", () => {
    const error = errorFromBody(500, null);
    expect([error.code, error.message]).toEqual(["http_500", "Something went wrong on our side. Please try again."]);
  });
});

describe("downloadFile", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("only fetches this site's own paths", async () => {
    await expect(downloadFile("https://evil.example/x", "x")).rejects.toThrow(TypeError);
    await expect(downloadFile("//evil.example/x", "x")).rejects.toThrow(TypeError);
  });

  it("turns error responses into ApiClientError with the server message", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: "invoice_unavailable", message: "The tax invoice is available once the payment is confirmed." } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadFile("/api/orders/AX-1/invoice.pdf", "x.pdf")).rejects.toMatchObject({
      status: 409,
      code: "invoice_unavailable",
      message: "The tax invoice is available once the payment is confirmed.",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/orders/AX-1/invoice.pdf", expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });

  it("reports network failures as status 0", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(downloadFile("/api/account/orders/export.csv", "orders.csv")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("saves the body under the server's file name", async () => {
    const link = { href: "", download: "", rel: "", style: { display: "" }, click: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("document", { createElement: vi.fn(() => link), body: { appendChild: vi.fn() } });
    vi.stubGlobal("window", { setTimeout: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("csv", { status: 200, headers: { ...csvHeaders("orders.csv"), "X-Export-Rows": "3" } })));
    const result = await downloadFile("/api/account/orders/export.csv", "fallback.csv");
    expect(result.fileName).toBe("orders.csv");
    expect(result.headers.get("x-export-rows")).toBe("3");
    expect(link.download).toBe("orders.csv");
    expect(link.click).toHaveBeenCalledOnce();
  });
});
