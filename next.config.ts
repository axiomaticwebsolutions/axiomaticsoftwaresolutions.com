import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";
import { contentSecurityPolicy, RAZORPAY_PAGE_PATTERNS } from "./lib/security/csp";
import { baseSecurityHeaders, parseHstsStrict, RAZORPAY_PAGE_HEADERS } from "./lib/security/headers";

const isDev = process.env.NODE_ENV !== "production";

// ---------------------------------------------------------------------------------------------------------------
// exFAT build fix (dev machines only).
// Windows on exFAT/FAT volumes (this repo's E: drive) has no reparse points, and libuv reports the wrong errno for
// two calls: readlink() on a regular file or directory gives EISDIR (NTFS/POSIX: EINVAL), and readFile() on a
// directory gives EINVAL (NTFS/POSIX: EISDIR). Next's build tracing treats only EINVAL/ENOENT as "not a symlink" and
// aborts the build; webpack's cache snapshot treats only EISDIR as "is a directory" and skips caching.
// The fix maps the errors back. It activates only after a probe shows the bad behaviour, so NTFS, Linux, macOS and
// production servers are untouched.
// ---------------------------------------------------------------------------------------------------------------

type FsCallback = (err: NodeJS.ErrnoException | null, value?: unknown) => void;
type FsMethod = (p: unknown, ...rest: unknown[]) => unknown;

function errnoError(code: "EINVAL" | "EISDIR", errno: number, syscall: string, p: unknown): NodeJS.ErrnoException {
  const message = code === "EINVAL" ? "invalid argument" : "illegal operation on a directory";
  return Object.assign(new Error(`${code}: ${message}, ${syscall} '${String(p)}'`), { code, errno, syscall, path: String(p) });
}

function isPathLike(p: unknown): p is fs.PathLike {
  return typeof p === "string" || Buffer.isBuffer(p) || p instanceof URL;
}

/** readlink: EISDIR on something that is not a symlink becomes EINVAL ("not a link"). */
function translateReadlinkError(err: unknown, p: unknown): unknown {
  if ((err as NodeJS.ErrnoException | null)?.code !== "EISDIR" || !isPathLike(p)) return err;
  try {
    return fs.lstatSync(p).isSymbolicLink() ? err : errnoError("EINVAL", -4071, "readlink", p);
  } catch {
    return err;
  }
}

/** readFile: EINVAL on a directory becomes EISDIR. */
function translateReadFileError(err: unknown, p: unknown): unknown {
  if ((err as NodeJS.ErrnoException | null)?.code !== "EINVAL" || !isPathLike(p)) return err;
  try {
    return fs.statSync(p).isDirectory() ? errnoError("EISDIR", -4068, "read", p) : err;
  } catch {
    return err;
  }
}

function probeExfatErrnos(): boolean {
  if (process.platform !== "win32") return false;
  try {
    fs.readlinkSync(path.join(process.cwd(), "package.json"));
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EISDIR";
  }
}

const wrappedTargets = new WeakSet<object>();

/** Wraps the callback-style readlink/readFile of an fs-like object (node:fs or a webpack file system). */
function wrapCallbackFs(target: Record<string, unknown> | null | undefined): void {
  if (!target || wrappedTargets.has(target)) return;
  wrappedTargets.add(target);
  const wrap = (name: "readlink" | "readFile", translate: (err: unknown, p: unknown) => unknown) => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function wrapped(p: unknown, ...rest: unknown[]) {
      const cb = rest.pop();
      if (typeof cb !== "function") return (original as FsMethod).call(target, p, ...rest, cb);
      return (original as FsMethod).call(target, p, ...rest, (err: NodeJS.ErrnoException | null, value?: unknown) =>
        (cb as FsCallback)(translate(err, p) as NodeJS.ErrnoException | null, value),
      );
    };
  };
  wrap("readlink", translateReadlinkError);
  wrap("readFile", translateReadFileError);
}

/** Patches node:fs readlink in this process (Next's collect-build-traces calls fs.promises.readlink). */
function patchNodeFsReadlink(): void {
  const marker = Symbol.for("axs.exfatReadlinkPatched");
  const state = globalThis as typeof globalThis & { [marker]?: true };
  if (state[marker]) return;
  state[marker] = true;

  const readlinkSync = fs.readlinkSync as unknown as FsMethod;
  fs.readlinkSync = function patchedReadlinkSync(p: unknown, ...rest: unknown[]) {
    try {
      return readlinkSync.call(fs, p, ...rest);
    } catch (err) {
      throw translateReadlinkError(err, p);
    }
  } as typeof fs.readlinkSync;

  const readlinkPromise = fs.promises.readlink as unknown as (p: unknown, ...rest: unknown[]) => Promise<unknown>;
  fs.promises.readlink = async function patchedReadlink(p: unknown, ...rest: unknown[]) {
    try {
      return await readlinkPromise.call(fs.promises, p, ...rest);
    } catch (err) {
      throw translateReadlinkError(err, p);
    }
  } as typeof fs.promises.readlink;

  const readlink = fs.readlink as unknown as FsMethod;
  fs.readlink = function patchedReadlinkCb(p: unknown, ...rest: unknown[]) {
    const cb = rest.pop() as FsCallback;
    readlink.call(fs, p, ...rest, (err: NodeJS.ErrnoException | null, link?: unknown) =>
      cb(translateReadlinkError(err, p) as NodeJS.ErrnoException | null, link),
    );
  } as typeof fs.readlink;
}

type WebpackCompilerLike = { inputFileSystem?: object | null; intermediateFileSystem?: object | null };

/**
 * webpack's file systems cloned node:fs before this file loaded, so they are wrapped directly: the input file system
 * feeds Next's trace plugin, the intermediate one feeds the persistent-cache snapshots.
 */
const exfatFsPlugin = {
  apply(compiler: WebpackCompilerLike): void {
    wrapCallbackFs(compiler.inputFileSystem as Record<string, unknown> | null | undefined);
    wrapCallbackFs(compiler.intermediateFileSystem as Record<string, unknown> | null | undefined);
  },
};

const exfatFixNeeded = probeExfatErrnos();
if (exfatFixNeeded) patchNodeFsReadlink();

// ---------------------------------------------------------------------------------------------------------------

// Security headers (docs/security.md; lib/security/*). Computed by `next build`: SECURITY_HSTS_STRICT must be set for the
// production build. No storage bucket here: it is runtime configuration (Admin > Settings > Integrations).
// - Every response: the STATIC Content-Security-Policy ('unsafe-inline' scripts) WITHOUT a bucket origin, nosniff,
//   Referrer-Policy, X-Frame-Options, Permissions-Policy, COOP and (production) HSTS. API JSON and /_next assets keep it.
// - middleware.ts (Node.js runtime, every page) replaces the CSP: the static policy plus the runtime bucket origin, or
//   the STRICT nonce policy on the dynamic routes (portal, admin, checkout, order pages, auth pages), including Razorpay
//   Checkout.js on /checkout and /orders/:id.
// - The Razorpay pages also get a Permissions-Policy that lets its iframes use the Payment Request API and
//   COOP same-origin-allow-popups (bank / 3-D Secure windows). Listed after the catch-all: when two entries set the
//   same header key, Next keeps the later one.
const staticCsp = contentSecurityPolicy({ dev: isDev });
const hstsStrict = parseHstsStrict(process.env.SECURITY_HSTS_STRICT);

const nextConfig: NextConfig = {
  // NEXT_DIST_DIR lets a production build run next to a running dev server (which owns .next).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  // Metadata in <head> for every user agent: dynamic pages (/software, /contact, /sign-in) otherwise stream it into
  // <body>, Googlebot included (docs/performance.md). The metadata is static, so blocking on it costs no TTFB.
  htmlLimitedBots: /.*/,
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/:path*", headers: baseSecurityHeaders({ csp: staticCsp, dev: isDev, hstsStrict }) },
      ...RAZORPAY_PAGE_PATTERNS.map((source) => ({ source, headers: [...RAZORPAY_PAGE_HEADERS] })),
    ];
  },
  // Only registered on exFAT dev machines, so everywhere else Next keeps its default (worker-based) webpack build.
  ...(exfatFixNeeded
    ? {
        webpack(config: { plugins?: unknown[] }) {
          (config.plugins ??= []).push(exfatFsPlugin);
          return config;
        },
      }
    : {}),
};

export default nextConfig;
