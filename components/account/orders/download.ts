/**
 * File downloads from the app's own API (accountant CSV, invoice PDF). fetch + Blob instead of a plain link, so a
 * refused request (429 rate limit, 409 invoice not ready, an expired session) shows the server's message in a toast
 * instead of saving the JSON error as a file. Same-origin paths only. Parsing helpers are pure (unit-tested).
 */
import { ApiClientError, NETWORK_ERROR_MESSAGE, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";

/** Path separators, Windows reserved characters and quotes are replaced in saved file names. */
const UNSAFE_FILE_CHARS = /[<>:"/|?*]/g;
const BACKSLASH = 92;

/** A file name that is safe to hand to `<a download>`: no controls, separators or leading dots; 120 chars max. */
export function safeFileName(name: string, fallback: string): string {
  const cleaned = Array.from(name)
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 32 && code !== 127 && code !== BACKSLASH;
    })
    .join("")
    .replace(UNSAFE_FILE_CHARS, "-")
    .trim()
    .replace(/^[.]+/, "");
  return cleaned ? cleaned.slice(0, 120) : fallback;
}

/**
 * File name from a Content-Disposition header: RFC 5987 `filename*=UTF-8''...` first, then `filename="..."` or a bare
 * token, else the fallback.
 */
export function fileNameFromDisposition(header: string | null | undefined, fallback: string): string {
  if (!header) return fallback;
  const star = /filename[*]=(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return safeFileName(decodeURIComponent(star[1].trim()), fallback);
    } catch {
      // Malformed percent-encoding: fall back to the plain parameter.
    }
  }
  const quoted = /filename="([^"]*)"/.exec(header);
  if (quoted?.[1]) return safeFileName(quoted[1], fallback);
  const bare = /filename=([^;"]+)/.exec(header);
  if (bare?.[1]) return safeFileName(bare[1].trim(), fallback);
  return fallback;
}

/** The API error envelope { error: { code, message, ...details } } as an ApiClientError (like apiFetch). */
export function errorFromBody(status: number, body: unknown): ApiClientError {
  const envelope = (body as { error?: unknown } | null)?.error;
  if (envelope && typeof envelope === "object") {
    const { code, message, ...details } = envelope as Record<string, unknown>;
    if (typeof code === "string" && typeof message === "string") return new ApiClientError(status, code, message, details);
  }
  return new ApiClientError(status, `http_${status}`, UNEXPECTED_ERROR_MESSAGE);
}

/** Saves a Blob under `fileName` through a temporary object URL (browser only). */
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
  // Revoke after the browser has started the download (Safari needs a tick).
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type DownloadResult = { fileName: string; headers: Headers };

/**
 * GETs one of this site's paths and saves the response as a file. Throws ApiClientError (status 0 for network
 * failures) with the server's message; an abort rethrows untouched.
 */
export async function downloadFile(path: string, fallbackName: string, signal?: AbortSignal): Promise<DownloadResult> {
  if (!path.startsWith("/") || path.startsWith("//")) throw new TypeError("downloadFile only fetches this site's own paths.");
  let res: Response;
  try {
    res = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiClientError(0, "network_error", NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    throw errorFromBody(res.status, body);
  }
  const blob = await res.blob();
  const fileName = fileNameFromDisposition(res.headers.get("content-disposition"), fallbackName);
  saveBlob(blob, fileName);
  return { fileName, headers: res.headers };
}
