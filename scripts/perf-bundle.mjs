/**
 * JavaScript and page-weight report for a production build (docs/performance.md "Bundle budgets"). Dev tool, no
 * dependencies beyond Node 20.19+.
 *
 *   node scripts/perf-bundle.mjs --dist=.next [--budget=250] [--only=store|account|admin] [--json]
 *     First-load JS of every app page from the build manifests: the same gzip sizes `next build` prints in its
 *     "First Load JS" column (page entry chunks, which include the root main files). Pages over --budget kB are
 *     flagged. Then the largest chunks that are not shared by every page, with the libraries recognised in each
 *     (signature strings, so it works on minified chunks) and how many pages load them.
 *   node scripts/perf-bundle.mjs --base=http://localhost:3150 [--paths=/,/software,...] [--json]
 *     What a browser downloads for each page of a running production server (`next start`): the HTML document
 *     (raw / gzip) and every same-origin <script src> it references (raw / gzip), the real first-load JavaScript
 *     including layout chunks.
 *
 * Exits 1 when --dist finds a storefront page over the budget (CI can gate on it), 2 on a usage error.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const opt = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.length ? rest.join("=") : "true"];
  }),
);

const BUDGET_KB = Number(opt.budget ?? 250);
const JSON_OUT = opt.json === "true";
const DEFAULT_PATHS = [
  "/",
  "/software",
  "/software/medical-billing",
  "/pricing",
  "/contact",
  "/cart",
  "/compare",
  "/support",
  "/docs/getting-started",
  "/sign-in",
];

if (!opt.dist && !opt.base) {
  console.error("Usage: --dist=<distDir> (build manifests) or --base=<url> (running production server). See the header.");
  process.exit(2);
}

const gzipSize = (buf) => zlib.gzipSync(buf, { level: 9 }).length;
const kb = (bytes) => (bytes / 1000).toFixed(1);

/** Signature strings that survive minification, so chunks can be labelled without source maps. */
const SIGNATURES = [
  ["radix-ui barrel (every primitive)", (s) => s.includes("NavigationMenu") && s.includes("HoverCard")],
  ["radix-ui primitives", (s) => s.includes("data-radix") || s.includes("DismissableLayer") || s.includes("FocusScope")],
  ["react-remove-scroll", (s) => s.includes("right-scroll-bar-position")],
  ["icon registry", (s) => s.includes("add_to_queue")],
  ["zod", (s) => s.includes("ZodError")],
  ["sonner", (s) => s.includes("data-sonner")],
  ["tailwind-merge", (s) => s.includes("conflictingClassGroups")],
  ["@tanstack/react-table", (s) => s.includes("getCoreRowModel")],
  ["react-hook-form", (s) => s.includes("shouldUnregister")],
  ["cmdk", (s) => s.includes("cmdk-")],
];

function labels(source) {
  return SIGNATURES.filter(([, test]) => test(source)).map(([name]) => name);
}

/** "/(store)/software/[slug]/page" -> "/software/[slug]". */
function routeOf(page) {
  const route = page.replace(/\/page$/, "").replace(/\/\([^)]+\)/g, "");
  return route === "" ? "/" : route;
}

function areaOf(route) {
  if (route.startsWith("/account")) return "account";
  if (route.startsWith("/admin")) return "admin";
  if (route.startsWith("/dev")) return "dev";
  return "store";
}

function fromDist(distDir) {
  const dist = path.resolve(distDir);
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, "app-build-manifest.json"), "utf8"));
  const sizes = new Map();
  const sizeOf = (file) => {
    if (!sizes.has(file)) {
      const buf = fs.readFileSync(path.join(dist, file));
      sizes.set(file, { raw: buf.length, gz: gzipSize(buf), labels: labels(buf.toString("utf8")) });
    }
    return sizes.get(file);
  };
  const pages = Object.entries(manifest.pages)
    .filter(([page]) => page.endsWith("/page") && !page.includes("[...slug]") && page !== "/_not-found/page")
    .map(([page, files]) => {
      const js = files.filter((f) => f.endsWith(".js"));
      const gz = js.reduce((n, f) => n + sizeOf(f).gz, 0);
      return { route: routeOf(page), area: areaOf(routeOf(page)), chunks: js, gz };
    })
    .filter((p) => !opt.only || p.area === opt.only)
    .sort((a, b) => b.gz - a.gz);

  const usage = new Map();
  for (const p of pages) for (const f of p.chunks) usage.set(f, (usage.get(f) ?? 0) + 1);
  const notEverywhere = [...usage]
    .filter(([, n]) => n < pages.length)
    .map(([file, n]) => ({ file, pages: n, ...sizeOf(file) }))
    .sort((a, b) => b.gz - a.gz)
    .slice(0, 15);

  const over = pages.filter((p) => p.gz / 1000 > BUDGET_KB);
  if (JSON_OUT) {
    const out = { budgetKb: BUDGET_KB, pages: pages.map(({ chunks, ...p }) => ({ ...p, chunks: chunks.length })), chunks: notEverywhere };
    console.info(JSON.stringify(out, null, 2));
  } else {
    console.info(`First-load JS per page (gzip, kB; budget ${BUDGET_KB} kB):`);
    for (const p of pages) {
      const flag = p.gz / 1000 > BUDGET_KB ? "  OVER" : "";
      console.info(`  ${kb(p.gz).padStart(6)}  ${p.area.padEnd(7)} ${p.route}${flag}`);
    }
    console.info("\nLargest chunks not loaded by every page (gzip kB, pages using it, recognised content):");
    for (const c of notEverywhere) {
      console.info(`  ${kb(c.gz).padStart(6)}  ${String(c.pages).padStart(3)}  ${path.basename(c.file)}  ${c.labels.join(", ") || "app code"}`);
    }
    console.info(`\n${over.length} page(s) over ${BUDGET_KB} kB.`);
  }
  return over.some((p) => p.area === "store") ? 1 : 0;
}

/** <script src> tags a module-capable browser runs (nomodule polyfills are skipped, as modern browsers skip them). */
const SCRIPT_TAG = /<script[^>]*>/g;
const SRC_ATTR = /\ssrc="([^"]+)"/;

function scriptSources(html, origin) {
  return [...html.matchAll(SCRIPT_TAG)]
    .map((m) => m[0])
    .filter((tag) => !/nomodule/i.test(tag))
    .map((tag) => tag.match(SRC_ATTR)?.[1])
    .filter(Boolean)
    .map((src) => new URL(src.replace(/&amp;/g, "&"), origin).href);
}

async function fromServer(base) {
  const origin = new URL(base).origin;
  const paths = opt.paths ? opt.paths.split(",").map((p) => p.trim()).filter(Boolean) : DEFAULT_PATHS;
  const cache = new Map();
  const asset = async (url) => {
    if (!cache.has(url)) {
      const res = await fetch(url);
      const buf = Buffer.from(await res.arrayBuffer());
      cache.set(url, { status: res.status, raw: buf.length, gz: gzipSize(buf), labels: labels(buf.toString("utf8")) });
    }
    return cache.get(url);
  };
  const rows = [];
  for (const p of paths) {
    const res = await fetch(origin + p, { headers: { "accept-encoding": "identity" } });
    const html = Buffer.from(await res.arrayBuffer());
    const srcs = scriptSources(html.toString("utf8"), origin);
    const scripts = [];
    for (const src of srcs.filter((s) => s.startsWith(origin))) scripts.push({ src, ...(await asset(src)) });
    rows.push({
      path: p,
      status: res.status,
      htmlRaw: html.length,
      htmlGz: gzipSize(html),
      scripts: scripts.length,
      jsRaw: scripts.reduce((n, s) => n + s.raw, 0),
      jsGz: scripts.reduce((n, s) => n + s.gz, 0),
      libraries: [...new Set(scripts.flatMap((s) => s.labels))],
    });
  }
  if (JSON_OUT) {
    console.info(JSON.stringify(rows, null, 2));
    return 0;
  }
  console.info(`Page weight at ${origin} (kB, raw / gzip level 9):`);
  console.info(`  ${"path".padEnd(26)} status  html raw/gz     js raw/gz      scripts`);
  for (const r of rows) {
    const html = `${kb(r.htmlRaw).padStart(6)}/${kb(r.htmlGz).padEnd(6)}`;
    const js = `${kb(r.jsRaw).padStart(6)}/${kb(r.jsGz).padEnd(6)}`;
    console.info(`  ${r.path.padEnd(26)} ${String(r.status).padEnd(6)}  ${html}  ${js}  ${r.scripts}`);
    if (r.libraries.length) console.info(`  ${"".padEnd(26)} ${r.libraries.join(", ")}`);
  }
  return 0;
}

process.exitCode = opt.dist ? fromDist(opt.dist) : await fromServer(opt.base);
