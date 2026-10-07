/**
 * File downloads from the app's own API (activity-log.csv, the account export): fetch with the session cookie, report
 * the server's error envelope as an ApiClientError (so the page can toast "Too many requests…" instead of navigating
 * to a JSON error), then save the bytes untouched (Response.blob keeps the CSV's UTF-8 BOM; text() would drop it).
 * fileNameFromDisposition is pure; downloadFromApi/saveBlob need a browser.
 */
import { ApiClientError, NETWORK_ERROR_MESSAGE, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";

/** Characters a saved file name must not contain (path separators, reserved Windows characters). */
const RESERVED_NAME_CHARS = "/\\:*?\"<>|";

function cleanName(name: string): string {
  let out = "";
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f || RESERVED_NAME_CHARS.includes(ch) ? "_" : ch;
  }
  return out.trim().slice(0, 150);
}

/** The download name from Content-Disposition (RFC 5987 `filename*` first, then `filename`), else `fallback`. */
export function fileNameFromDisposition(header: string | null | undefined, fallback: string): string {
  if (header) {
    const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
    if (extended?.[1]) {
      try {
        const name = cleanName(decodeURIComponent(extended[1].trim()));
        if (name) return name;
      } catch {
        // fall through to the plain parameter
      }
    }
    const quoted = /filename\s*=\s*"([^"]*)"/.exec(header) ?? /filename\s*=\s*([^;]+)/.exec(header);
    const plain = quoted?.[1] ? cleanName(quoted[1]) : "";
    if (plain) return plain;
  }
  return fallback;
}

/** Saves a blob under `fileName` through a temporary object URL. */
export function saveBlob(blob: Blob, fileName: string): void {
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

export type DownloadResult = { fileName: string; headers: Headers };

/** GETs a same-origin path and saves the response as a file. Throws ApiClientError on HTTP or network errors. */
export async function downloadFromApi(path: string, fallbackName: string): Promise<DownloadResult> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new TypeError("downloadFromApi only fetches this site's own paths.");
  let res: Response;
  try {
    res = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiClientError(0, "network_error", NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) throw await errorFrom(res);
  const blob = await res.blob();
  const fileName = fileNameFromDisposition(res.headers.get("content-disposition"), fallbackName);
  saveBlob(blob, fileName);
  return { fileName, headers: res.headers };
}
