/**
 * GET /brand/:file (public): the uploaded branding files of Admin > Settings > Branding (docs/api.md "Branding").
 * `:file` is `logo-light`, `logo-dark` or `favicon` (the stored file: PNG, WebP, SVG or ICO), the same name + `.png`
 * (the PNG rendition: logos at most 160 px tall for emails and PDFs, the 180 px favicon with its transparency) or
 * `favicon-apple.png` (that favicon rendition on an opaque background, for apple-touch-icon). Anything else, and an
 * empty slot, is 404 (no-store).
 *
 * Headers: the stored type, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, and
 * `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` (middleware.ts sets the same on
 * every /brand response, so an SVG opened directly runs nothing). `?v=` is the content version (first 12 hex of the
 * SHA-256): when it matches, `Cache-Control: public, max-age=31536000, immutable`; without `v`, a 5-minute cache; with
 * a `v` this process does not hold (an old link, or a new upload another PM2 process has not read yet), `no-store`,
 * so no browser or proxy keeps other bytes under that versioned URL. ETag + If-None-Match answer 304. Same origin, so the pages' `img-src 'self'` allows it; nothing to
 * add in Nginx (everything is proxied).
 */
import type { NextRequest } from "next/server";
import { brandFileName, parseBrandFile } from "@/lib/branding/model";
import { readBrandFile } from "@/lib/branding/store";
import { route } from "@/lib/http";
import { BRAND_ASSET_CSP } from "@/lib/security/csp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ file: string }> };

const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
const SHORT_CACHE = "public, max-age=300";
/** A requested version other than the one served: never cached (lib/branding/store.ts re-reads within 2 seconds). */
const OTHER_VERSION_CACHE = "no-store";

const ETAG_SUFFIX = { original: "", png: "-png", apple: "-apple" } as const;

function notFound(): Response {
  return new Response("Not found.", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": BRAND_ASSET_CSP,
    },
  });
}

/** ETag `If-None-Match` matches (a list, weak validators and `*` included). */
function etagMatches(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const tag = part.trim().replace(/^W\//, "");
    return tag === "*" || tag === etag;
  });
}

export const GET = route<Context>(async (req: NextRequest, { params }) => {
  const parsed = parseBrandFile((await params).file);
  if (!parsed) return notFound();
  const version = req.nextUrl.searchParams.get("v");
  const file = await readBrandFile(parsed.slot, parsed.variant, version);
  if (!file) return notFound();

  const etag = `"${file.sha256.slice(0, 32)}${ETAG_SUFFIX[parsed.variant]}"`;
  const headers = new Headers({
    "cache-control": version === file.version ? IMMUTABLE_CACHE : version ? OTHER_VERSION_CACHE : SHORT_CACHE,
    etag,
    "x-content-type-options": "nosniff",
    "content-security-policy": BRAND_ASSET_CSP,
  });
  if (etagMatches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });

  headers.set("content-type", file.contentType);
  headers.set("content-length", String(file.body.length));
  headers.set("content-disposition", `inline; filename="${brandFileName(parsed.slot, file.format, parsed.variant)}"`);
  return new Response(new Uint8Array(file.body), { status: 200, headers });
});
