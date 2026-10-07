/**
 * Downloads a CSV from an admin export route with fetch + Blob, so a refusal (403 for a role without
 * reports.export, an expired session) shows the server's message instead of saving the JSON error as a file.
 * Same-origin paths only. Browser only.
 */
import { ApiClientError, NETWORK_ERROR_MESSAGE, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";

const BACKSLASH = 92;
const UNSAFE = '<>:"/|?*';

type ErrorEnvelope = { error?: { code?: unknown; message?: unknown } };

export type AdminDownload = { fileName: string; rows: number | null; truncated: boolean };

function fileNameFrom(header: string | null, fallback: string): string {
  const star = header ? /filename\*=UTF-8''([^;]+)/i.exec(header) : null;
  let name = fallback;
  if (star?.[1]) {
    try {
      name = decodeURIComponent(star[1].trim());
    } catch {
      name = fallback;
    }
  } else {
    const plain = header ? /filename="([^"]+)"/i.exec(header) : null;
    if (plain?.[1]) name = plain[1];
  }
  // Controls, path separators, Windows reserved characters and quotes become "-".
  const cleaned = Array.from(name)
    .map((c) => {
      const code = c.charCodeAt(0);
      return code < 32 || code === 127 || code === BACKSLASH || UNSAFE.includes(c) ? "-" : c;
    })
    .join("");
  const safe = cleaned.replace(/^\.+/, "").slice(0, 120);
  return safe || fallback;
}

export async function downloadAdminCsv(path: string, fallbackName: string): Promise<AdminDownload> {
  if (!path.startsWith("/api/")) throw new Error("Same-origin API paths only.");
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiClientError(0, "network_error", NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) {
    let envelope: ErrorEnvelope | null = null;
    try {
      envelope = (await res.json()) as ErrorEnvelope | null;
    } catch {
      envelope = null;
    }
    const code = typeof envelope?.error?.code === "string" ? envelope.error.code : `http_${res.status}`;
    const message = typeof envelope?.error?.message === "string" ? envelope.error.message : UNEXPECTED_ERROR_MESSAGE;
    throw new ApiClientError(res.status, code, message);
  }
  const blob = await res.blob();
  const fileName = fileNameFrom(res.headers.get("content-disposition"), fallbackName);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  const rows = Number(res.headers.get("x-row-count"));
  return { fileName, rows: Number.isFinite(rows) ? rows : null, truncated: res.headers.get("x-truncated") === "1" };
}
