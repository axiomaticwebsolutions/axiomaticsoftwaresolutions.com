/**
 * GET /api/dev/storage/<key>?exp=&sig=[&name=] (development only; decisions.md "Environment" and Phase 4).
 * Serves objects of the local storage driver (STORAGE_LOCAL_DIR) behind the HMAC-signed, short-lived URLs that
 * LocalStorageDriver.presignGet() creates, standing in for S3 presigned GETs.
 * - 404 unless NODE_ENV !== "production" and the effective storage driver is the local one (lib/storage getStorage;
 *   the middleware also 404s /api/dev/* in production).
 * - 404 for keys that are not storage keys: "..", ".", empty or absolute segments, backslashes, drive letters, etc.
 * - 403 `invalid_link` unless verifyLocalSignature() accepts the method, key, expiry and signature (constant time).
 * - 404 when the object does not exist.
 * The file is streamed with Content-Disposition: attachment (the unsigned `name`, sanitised, else the key's last
 * segment), Content-Type: application/octet-stream, nosniff and Cache-Control: no-store.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { ApiError, errors, route } from "@/lib/http";
import { attachmentDisposition, getStorage, isStorageKey } from "@/lib/storage";
import { LocalStorageDriver, verifyLocalSignature } from "@/lib/storage/local";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ key?: string[] }> };

const INVALID_LINK_MESSAGE = "This download link has expired or isn\u2019t valid. Create a new link and try again.";

/** The local driver when it is the effective one (development only), else null (the routes answer 404). */
async function localDriver(): Promise<LocalStorageDriver | null> {
  if (process.env.NODE_ENV === "production") return null;
  const driver = await getStorage().catch(() => null);
  return driver instanceof LocalStorageDriver ? driver : null;
}

export const GET = route<Context>(async (req, { params }) => {
  const driver = await localDriver();
  if (!driver) throw errors.notFound();
  const segments = (await params).key ?? [];
  const key = segments.join("/");
  if (segments.length === 0 || !isStorageKey(key)) throw errors.notFound();

  const query = new URL(req.url).searchParams;
  const exp = query.get("exp") ?? "";
  const sig = query.get("sig") ?? "";
  if (!verifyLocalSignature("GET", key, exp, sig, new Date())) {
    throw new ApiError(403, "invalid_link", INVALID_LINK_MESSAGE);
  }

  const filePath = driver.pathFor(key);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) throw errors.notFound();

  const name = query.get("name") || segments[segments.length - 1] || "download";
  const body = Readable.toWeb(createReadStream(filePath)) as unknown as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(info.size),
      "content-disposition": attachmentDisposition(name),
      "cache-control": "no-store, max-age=0",
      "x-content-type-options": "nosniff",
    },
  });
});

/**
 * PUT /api/dev/storage/<key>?exp=&sig=&max=&ct= (development only; Phase 5 ticket attachments). Stands in for an S3
 * presigned PUT made by LocalStorageDriver.presignPut(): the signature covers the key, expiry, `max` and `ct`, the
 * request's Content-Type must equal `ct` (S3 signs it too), and bodies above `max` bytes are refused while streaming
 * (413). Writes atomically through the driver and answers 200 with no body, like S3.
 */
export const PUT = route<Context>(async (req, { params }) => {
  const driver = await localDriver();
  if (!driver) throw errors.notFound();
  const segments = (await params).key ?? [];
  const key = segments.join("/");
  if (segments.length === 0 || !isStorageKey(key)) throw errors.notFound();

  const query = new URL(req.url).searchParams;
  const maxBytes = Number(query.get("max") ?? "");
  const contentType = query.get("ct") ?? "";
  const signed = verifyLocalSignature("PUT", key, query.get("exp") ?? "", query.get("sig") ?? "", new Date(), {
    maxBytes,
    contentType,
  });
  if (!signed) throw new ApiError(403, "invalid_link", INVALID_LINK_MESSAGE);
  const sent = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (sent !== contentType) throw new ApiError(403, "invalid_link", INVALID_LINK_MESSAGE);
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw errors.payloadTooLarge(maxBytes);

  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw errors.payloadTooLarge(maxBytes);
      }
      chunks.push(value);
    }
  }
  await driver.putObject(key, Buffer.concat(chunks), contentType);
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
});
