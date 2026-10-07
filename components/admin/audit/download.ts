/**
 * CSV downloads from the admin API (audit log, staff): fetch with the session cookie, surface the error envelope as an
 * ApiClientError (so the page can toast "Export needs Owner / Finance" instead of opening JSON), then save the bytes
 * untouched (Response.blob keeps the UTF-8 BOM). Browser only.
 */
import { ApiClientError, NETWORK_ERROR_MESSAGE, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";

/** Characters a saved file name must not contain (path separators and reserved Windows characters). */
const RESERVED = "/\\:*?\"<>|";

function cleanName(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f || RESERVED.includes(ch) ? "_" : ch;
  }
  return out.trim().slice(0, 150);
}

/** File name from Content-Disposition (RFC 5987 filename* first), else `fallback`. */
export function dispositionFileName(header: string | null | undefined, fallback: string): string {
  if (header) {
    const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
    if (extended?.[1]) {
      try {
        const name = cleanName(decodeURIComponent(extended[1].trim()));
        if (name) return name;
      } catch {
        // fall back to the plain parameter
      }
    }
    const plain = /filename\s*=\s*"([^"]*)"/.exec(header)?.[1];
    if (plain && cleanName(plain)) return cleanName(plain);
  }
  return fallback;
}

export type AdminDownload = { fileName: string; rows: number | null; truncated: boolean };

/** GETs an /api/admin CSV and saves it. Throws ApiClientError on HTTP or network errors. */
export async function downloadAdminCsv(path: string, fallbackName: string): Promise<AdminDownload> {
  if (!path.startsWith("/api/admin/")) throw new TypeError("downloadAdminCsv only fetches admin API paths.");
  let res: Response;
  try {
    res = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiClientError(0, "network_error", NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) {
    let error = new ApiClientError(res.status, `http_${res.status}`, UNEXPECTED_ERROR_MESSAGE);
    try {
      const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } };
      if (typeof body.error?.code === "string" && typeof body.error.message === "string") {
        error = new ApiClientError(res.status, body.error.code, body.error.message);
      }
    } catch {
      // not JSON
    }
    throw error;
  }
  const blob = await res.blob();
  const fileName = dispositionFileName(res.headers.get("content-disposition"), fallbackName);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  const count = Number(res.headers.get("x-row-count"));
  return { fileName, rows: Number.isFinite(count) && res.headers.has("x-row-count") ? count : null, truncated: res.headers.get("x-truncated") === "1" };
}
