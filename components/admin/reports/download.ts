/**
 * Report CSV downloads from the admin API: fetch with the session cookie, turn the error envelope into an
 * ApiClientError (so the page can toast the server's message instead of opening a JSON error), then save the bytes
 * untouched (Response.blob keeps the CSV's UTF-8 byte order mark). Pure helpers plus one browser-only function.
 */
import { ApiClientError, NETWORK_ERROR_MESSAGE, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";

/** Characters a saved file name must not contain (path separators, reserved Windows characters). */
const RESERVED = '/\\:*?"<>|';

function cleanName(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f || RESERVED.includes(ch) ? "_" : ch;
  }
  return out.trim().slice(0, 150);
}

/** The download name from Content-Disposition (RFC 5987 `filename*` first, then `filename`), else `fallback`. */
export function dispositionFileName(header: string | null | undefined, fallback: string): string {
  if (header) {
    const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
    if (extended?.[1]) {
      try {
        const name = cleanName(decodeURIComponent(extended[1].trim()));
        if (name) return name;
      } catch {
        // fall back to the plain parameter
      }
    }
    const plain = /filename\s*=\s*"([^"]*)"/i.exec(header) ?? /filename\s*=\s*([^;]+)/i.exec(header);
    const name = plain?.[1] ? cleanName(plain[1]) : "";
    if (name) return name;
  }
  return fallback;
}

export type ReportDownload = { fileName: string; rows: number; truncated: boolean };

/** Reads X-Row-Count and X-Truncated (lib/admin/export.ts). */
export function exportMeta(headers: Headers): { rows: number; truncated: boolean } {
  const rows = Number.parseInt(headers.get("x-row-count") ?? "", 10);
  return { rows: Number.isFinite(rows) && rows >= 0 ? rows : 0, truncated: headers.get("x-truncated") === "1" };
}

async function errorFrom(res: Response): Promise<ApiClientError> {
  try {
    const body = (await res.json()) as { error?: Record<string, unknown> } | null;
    const envelope = body?.error;
    if (envelope && typeof envelope.code === "string" && typeof envelope.message === "string") {
      const { code, message, ...details } = envelope;
      return new ApiClientError(res.status, code, message, details);
    }
  } catch {
    // not JSON
  }
  return new ApiClientError(res.status, `http_${res.status}`, UNEXPECTED_ERROR_MESSAGE);
}

/** GETs a same-origin export path and saves the file. Throws ApiClientError on HTTP or network errors. */
export async function downloadReport(path: string, fallbackName: string): Promise<ReportDownload> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new TypeError("downloadReport only fetches this site's own paths.");
  let res: Response;
  try {
    res = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiClientError(0, "network_error", NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) throw await errorFrom(res);
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
  return { fileName, ...exportMeta(res.headers) };
}
