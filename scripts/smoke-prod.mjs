/**
 * Production smoke test: non-destructive checks against a deployed site (docs/deploy-today.md step 10).
 *
 *   node scripts/smoke-prod.mjs --base https://<domain> [--provider razorpay] [--timeout 15000] [--json] [--verbose]
 *   node scripts/smoke-prod.mjs --base http://127.0.0.1:3000 --allow-http --app-url https://<domain>
 *       (on the server, before or without the aaPanel proxy: TLS, DNS and www checks are skipped)
 *   node scripts/smoke-prod.mjs --base http://localhost:3000 --allow-http --provider mock      (local dev server)
 *
 * Checks: DNS (A record; an AAAA record must really serve the site over IPv6); TLS certificate (valid, matches the
 * host, not about to expire, TLS 1.2+); plain HTTP redirects to HTTPS; www.<domain> redirects to the canonical host;
 * /api/health; storefront pages answer 200 with the security headers (CSP with frame-ancestors 'none', HSTS,
 * X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy, Cross-Origin-Opener-Policy,
 * X-Permitted-Cross-Domain-Policies, no 'unsafe-eval' in a production build); the auth, portal, admin and checkout
 * pages get the strict nonce policy (a fresh 'nonce-...' and 'strict-dynamic', no 'unsafe-inline' scripts) and /checkout
 * gets COOP same-origin-allow-popups for the Razorpay bank windows; canonical URL, sitemap and robots.txt use the site's own origin (APP_URL, or --app-url); /api/me is 401;
 * /admin and /account redirect to /sign-in on the same origin (Next.js sends same-origin redirects as relative paths;
 * an absolute one to another origin means the proxy rewrites Location); development routes (/dev/*, /api/dev/*) are
 * 404; source and env files (/.env, /package.json, ...) are not served; cron routes refuse requests without the
 * secret; a webhook with a bad signature is 401; the device API answers a junk token or key with 4xx, never 5xx (a
 * 503 there means Redis or the database is unreachable); unknown pages are 404; a /_next/static asset is served
 * through the proxy with the app's long-lived Cache-Control (no second expiry added by the proxy); the branding files
 * (/brand/logo-light, /brand/logo-dark, /brand/favicon: 404 when nothing is uploaded, else an image) carry nosniff and
 * the sandbox Content-Security-Policy, and other /brand names are 404.
 *
 * Never sends real data: no cookies, no sign-in, no form posts. The only writes it can cause are a
 * WebhookDelivery(invalid_signature) bookkeeping row and rate-limit counters. Prints a PASS/FAIL/WARN/SKIP table and
 * exits 1 when any check FAILs (2 on a usage error). Node 20.19+ (global fetch), no dependencies.
 */
import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

const BOOLEAN_FLAGS = new Set(["allow-http", "json", "help", "verbose"]);

function readOptions(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 2) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = args[i + 1];
    if (!BOOLEAN_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

const opt = readOptions(process.argv.slice(2));
const USAGE = [
  "Usage: node scripts/smoke-prod.mjs --base https://<domain> [--provider razorpay] [--timeout 15000] [--json] [--verbose]",
  "       node scripts/smoke-prod.mjs --base http://127.0.0.1:3000 --allow-http --app-url https://<domain>   (on the server)",
  "       node scripts/smoke-prod.mjs --base http://localhost:3000 --allow-http --provider mock              (dev server)",
].join("\n");

if (opt.help === "true" || !opt.base) {
  console.info(USAGE);
  process.exit(opt.help === "true" ? 0 : 2);
}

function parseUrlOption(name) {
  try {
    const url = new URL(opt[name]);
    if (url.protocol === "https:" || url.protocol === "http:") return url;
  } catch {
    // reported below
  }
  console.error(`--${name} is not an http(s) URL: ${opt[name]}\n${USAGE}`);
  process.exit(2);
}

const BASE_URL = parseUrlOption("base");
const ALLOW_HTTP = opt["allow-http"] === "true";
if (BASE_URL.protocol !== "https:" && !ALLOW_HTTP) {
  console.error("--base must be https://<domain> (pass --allow-http to test an http server such as http://127.0.0.1:3000).");
  process.exit(2);
}
const BASE = BASE_URL.origin;
const HOST = BASE_URL.hostname;
const IS_HTTPS = BASE_URL.protocol === "https:";
/** The public origin the site must use in links (APP_URL). Defaults to --base; set it when --base is the bare app. */
const ORIGIN = opt["app-url"] ? parseUrlOption("app-url").origin : BASE;
const PROVIDER = (opt.provider ?? "razorpay").trim().toLowerCase();
const TIMEOUT_MS = Math.max(1000, Number(opt.timeout ?? 15000) || 15000);
const JSON_OUT = opt.json === "true";
const VERBOSE = opt.verbose === "true";
const USER_AGENT = "axiomatic-smoke-test/1.1 (+scripts/smoke-prod.mjs)";
const ONE_YEAR_S = 31536000;
const FINGERPRINT = "0".repeat(64); // syntactically valid, belongs to no device
const SKIP_HTTP = "skipped on http";
/** A public DNS name (not an IP address and not a local name), so DNS, www and IPv6 checks make sense. */
const PUBLIC_NAME = IS_HTTPS && net.isIP(HOST) === 0 && HOST.includes(".") && !/(^|\.)localhost$/i.test(HOST);

/** @type {{ group: string, name: string, status: "PASS" | "FAIL" | "WARN" | "SKIP", detail: string }[]} */
const results = [];
function record(group, name, status, detail = "") {
  results.push({ group, name, status, detail });
  if (VERBOSE) console.info(`${status.padEnd(4)}  ${group} / ${name}  ${detail}`);
}
const pass = (g, n, d) => record(g, n, "PASS", d);
const fail = (g, n, d) => record(g, n, "FAIL", d);
const warn = (g, n, d) => record(g, n, "WARN", d);
const skip = (g, n, d) => record(g, n, "SKIP", d);

/**
 * One request without following redirects and without cookies. Returns the status, headers, body text (when asked)
 * and the time taken, or `error` when the request could not be made at all.
 */
async function request(path, { method = "GET", headers = {}, body, base = BASE, readBody = true } = {}) {
  const url = new URL(path, base);
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method,
      headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...headers },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let text = "";
    if (readBody) text = await res.text();
    else await res.body?.cancel();
    return { status: res.status, headers: res.headers, text, ms: Date.now() - started, url: url.href };
  } catch (e) {
    const cause = e?.cause?.code ?? e?.cause?.message ?? e?.name ?? "error";
    return { status: 0, headers: new Headers(), text: "", ms: Date.now() - started, url: url.href, error: String(cause) };
  }
}

function describe(res) {
  if (res.error) return `no response (${res.error})`;
  return `${res.status} in ${res.ms} ms`;
}

/** The error code of a JSON error envelope, if any ({ error: { code } }). */
function errorCode(res) {
  try {
    const parsed = JSON.parse(res.text);
    return parsed?.error?.code ?? parsed?.reason ?? null;
  } catch {
    return null;
  }
}

/** Resolves a redirect's Location against the URL that answered it. */
function locationOf(res) {
  const loc = res.headers.get("location");
  if (!loc) return null;
  try {
    return new URL(loc, res.url);
  } catch {
    return null;
  }
}

/**
 * Certificate facts from a TLS handshake with `address` (a name or an IP). Node checks the chain and the certificate
 * against `servername` (SNI; defaults to the address when it is a name). Verification is evaluated, not enforced, so
 * it can be reported.
 */
function tlsInfo(address, port, servername = net.isIP(address) === 0 ? address : undefined) {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: address, port, servername, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => {
      const cert = socket.getPeerCertificate();
      const err = socket.authorizationError;
      resolve({
        authorized: socket.authorized,
        authError: err ? String(err.code ?? err.message ?? err) : null,
        protocol: socket.getProtocol(),
        validTo: cert?.valid_to ?? null,
        issuer: cert?.issuer?.O ?? cert?.issuer?.CN ?? "unknown issuer",
        altNames: cert?.subjectaltname ?? "",
      });
      socket.end();
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve({ connectError: "ETIMEDOUT" });
    });
    socket.on("error", (e) => resolve({ connectError: String(e.code ?? e.message) }));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------------

async function checkTls() {
  const g = "TLS";
  if (!IS_HTTPS) {
    skip(g, "Certificate valid for the host", SKIP_HTTP);
    skip(g, "HTTP redirects to HTTPS", SKIP_HTTP);
    return;
  }
  const port = Number(BASE_URL.port || 443);
  const info = await tlsInfo(HOST, port);
  if (info.connectError) {
    fail(g, "Certificate valid for the host", `TLS handshake failed: ${info.connectError} (port ${port} open? site SSL on?)`);
  } else if (!info.authorized) {
    fail(g, "Certificate valid for the host", `${info.authError} (issuer ${info.issuer}; names ${info.altNames || "none"})`);
  } else {
    const daysLeft = Math.floor((Date.parse(info.validTo) - Date.now()) / 86400000);
    const detail = `${info.issuer}, ${info.protocol}, expires ${info.validTo} (${daysLeft} days)`;
    if (!["TLSv1.2", "TLSv1.3"].includes(info.protocol)) fail(g, "Certificate valid for the host", `old protocol: ${detail}`);
    else if (daysLeft < 14) warn(g, "Certificate valid for the host", `renews soon or renewal is failing: ${detail}`);
    else pass(g, "Certificate valid for the host", detail);
  }

  if (port !== 443) {
    skip(g, "HTTP redirects to HTTPS", "base uses a custom port");
    return;
  }
  const res = await request("/", { base: `http://${BASE_URL.host}`, readBody: false });
  const loc = locationOf(res);
  if (res.error) {
    fail(g, "HTTP redirects to HTTPS", `port 80 unreachable (${res.error}); Let's Encrypt renewal needs it open`);
  } else if ([301, 302, 307, 308].includes(res.status) && loc?.protocol === "https:" && loc.hostname === HOST) {
    pass(g, "HTTP redirects to HTTPS", `${res.status} -> ${loc.origin}`);
  } else if (res.status >= 300 && res.status < 400) {
    fail(g, "HTTP redirects to HTTPS", `${res.status} -> ${loc?.href ?? "no Location"} (expected https://${HOST}/)`);
  } else {
    fail(g, "HTTP redirects to HTTPS", `plain HTTP answered ${res.status}; turn on Force HTTPS in aaPanel > Website > SSL`);
  }
}

/** Network errors that mean "this computer has no IPv6 route", not "the server is broken". */
const NO_LOCAL_IPV6 = new Set(["ENETUNREACH", "EHOSTUNREACH", "EADDRNOTAVAIL", "EAFNOSUPPORT"]);

/** DNS answers meaning "no such record", as opposed to "the resolver could not be asked". */
const NO_RECORD = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

/**
 * The host's IPv4 or IPv6 addresses. Asks DNS directly first (dns.resolve*), and falls back to the operating system's
 * resolver (dns.lookup) when the direct query cannot be made, which happens on some Windows PCs and VPNs.
 * Returns { list, via, error, absent }: absent is true when DNS answered that there is no such record.
 */
async function addresses(family) {
  try {
    const list = family === 4 ? await dns.resolve4(HOST) : await dns.resolve6(HOST);
    return { list, via: "", error: null, absent: list.length === 0 };
  } catch (e) {
    const code = String(e?.code ?? e?.message ?? "error");
    if (NO_RECORD.has(code)) return { list: [], via: "", error: code, absent: true };
    try {
      const found = await dns.lookup(HOST, { family, all: true });
      const list = [...new Set(found.map((r) => r.address))];
      return { list, via: " (system resolver)", error: null, absent: list.length === 0 };
    } catch (e2) {
      const code2 = String(e2?.code ?? e2?.message ?? "error");
      return { list: [], via: "", error: `${code}, then ${code2}`, absent: NO_RECORD.has(code2) };
    }
  }
}

async function checkDns() {
  const g = "DNS";
  if (!PUBLIC_NAME) {
    skip(g, "A record", IS_HTTPS ? "base is an IP address or a local name" : SKIP_HTTP);
    skip(g, "AAAA record serves the site", IS_HTTPS ? "base is an IP address or a local name" : SKIP_HTTP);
    return;
  }
  const v4 = await addresses(4);
  if (v4.list.length > 0) pass(g, "A record", `${v4.list.join(", ")}${v4.via}`);
  else fail(g, "A record", `no IPv4 address for ${HOST} (${v4.error ?? "empty"}): add an A record pointing at the server`);

  const v6 = await addresses(6);
  if (v6.error && !v6.absent) {
    skip(g, "AAAA record serves the site", `could not look up AAAA records (${v6.error})`);
    return;
  }
  if (v6.list.length === 0) {
    pass(g, "AAAA record serves the site", "no AAAA record (IPv4 only)");
    return;
  }
  const info = await tlsInfo(v6.list[0], Number(BASE_URL.port || 443), HOST);
  const name = "AAAA record serves the site";
  if (info.connectError && NO_LOCAL_IPV6.has(info.connectError)) {
    warn(g, name, `AAAA ${v6.list.join(", ")} exists but this computer has no IPv6 to test it; delete it unless the server serves IPv6`);
  } else if (info.connectError === "ETIMEDOUT") {
    warn(g, name, `AAAA ${v6.list[0]}: no answer on 443 within ${TIMEOUT_MS} ms; delete the AAAA record unless the server serves IPv6`);
  } else if (info.connectError) {
    fail(g, name, `AAAA ${v6.list[0]}: ${info.connectError}. IPv6 visitors and Let's Encrypt cannot reach the site: delete the AAAA record`);
  } else if (!info.authorized) {
    fail(g, name, `AAAA ${v6.list[0]}: certificate problem over IPv6 (${info.authError}); delete the AAAA record or fix the IPv6 site`);
  } else pass(g, name, `${v6.list[0]} serves a valid certificate`);
}

async function checkWww() {
  const g = "TLS";
  const name = "www redirects to the canonical host";
  if (!PUBLIC_NAME) return skip(g, name, IS_HTTPS ? "base is an IP address or a local name" : SKIP_HTTP);
  const canonicalHost = new URL(ORIGIN).hostname;
  const other = canonicalHost.startsWith("www.") ? canonicalHost.slice(4) : `www.${canonicalHost}`;
  const found = await dns.lookup(other).catch(() => null);
  if (!found) return skip(g, name, `${other} has no DNS record`);
  const res = await request("/", { base: `https://${other}`, readBody: false });
  const loc = locationOf(res);
  if (res.error) {
    return warn(g, name, `${other} resolves but HTTPS fails (${res.error}): add it to the certificate or delete its DNS record`);
  }
  if ([301, 308].includes(res.status) && loc?.origin === ORIGIN) return pass(g, name, `https://${other} ${res.status} -> ${loc.origin}`);
  if (res.status === 200) {
    return warn(g, name, `https://${other} serves the site (200); sign-in and forms only accept ${ORIGIN}: redirect it`);
  }
  return warn(g, name, `https://${other} answered ${res.status} -> ${loc?.href ?? "no Location"} (expected 301 to ${ORIGIN})`);
}

async function checkHealth() {
  const g = "Health";
  const res = await request("/api/health", { headers: { Accept: "application/json" } });
  if (res.status !== 200) {
    const hints = {
      0: " (nothing answers: on the server run `sudo -iu axiomatic pm2 status` and `curl -i http://127.0.0.1:3000/api/health`)",
      502: " (the proxy cannot reach the app on 127.0.0.1:3000: `sudo -iu axiomatic pm2 status`, then `... pm2 logs axiomatic --lines 100`)",
      503: " (PostgreSQL or Redis unreachable: look for health_check_failed in `sudo -iu axiomatic pm2 logs axiomatic`)",
      504: " (the proxy timed out waiting for the app)",
    };
    const hint = hints[res.error ? 0 : res.status] ?? "";
    const code = errorCode(res);
    fail(g, "GET /api/health is 200", `${describe(res)}${hint}${code ? ` ${code}` : ""}`);
    return;
  }
  let summary = res.text.replace(/\s+/g, " ").slice(0, 160);
  try {
    const body = JSON.parse(res.text);
    summary = Object.entries(body)
      .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v) || (v && typeof v === "object" && !Array.isArray(v)))
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ")
      .slice(0, 160);
  } catch {
    // not JSON: show the start of the text
  }
  if (!(res.headers.get("cache-control") ?? "").includes("no-store")) {
    warn(g, "GET /api/health is 200", `${res.ms} ms ${summary}, but Cache-Control is not no-store (proxy cache on?)`);
  } else pass(g, "GET /api/health is 200", `${res.ms} ms ${summary}`);
}

const STOREFRONT_PAGES = [
  "/",
  "/software",
  "/pricing",
  "/about",
  "/contact",
  "/support",
  "/legal/terms",
  "/sign-in",
  "/register",
  "/forgot",
  "/cart",
  "/checkout",
];

/** Dev builds add 'unsafe-eval' to script-src; production builds never do. */
let looksLikeDevServer = false;
let homeHtml = "";

function cspDirectives(csp) {
  const map = new Map();
  for (const part of (csp ?? "").split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name.toLowerCase(), values);
  }
  return map;
}

function checkSecurityHeaders(res) {
  const g = "Headers";
  const h = res.headers;
  const csp = h.get("content-security-policy");
  const d = cspDirectives(csp);
  looksLikeDevServer = (d.get("script-src") ?? []).includes("'unsafe-eval'");

  if (!csp) fail(g, "Content-Security-Policy", "missing");
  else if ((d.get("frame-ancestors") ?? []).join(" ") !== "'none'") fail(g, "Content-Security-Policy", "frame-ancestors is not 'none'");
  else if (!(d.get("default-src") ?? []).includes("'self'") || !(d.get("object-src") ?? []).includes("'none'")) {
    fail(g, "Content-Security-Policy", "default-src 'self' / object-src 'none' missing");
  } else pass(g, "Content-Security-Policy", "frame-ancestors 'none', default-src 'self', object-src 'none'");

  if (!looksLikeDevServer) pass(g, "CSP without 'unsafe-eval'", "production build");
  else if (IS_HTTPS) fail(g, "CSP without 'unsafe-eval'", "script-src allows 'unsafe-eval': this is not a production build");
  else skip(g, "CSP without 'unsafe-eval'", "development server over http (allowed there)");

  const hsts = h.get("strict-transport-security");
  if (!IS_HTTPS) skip(g, "Strict-Transport-Security", SKIP_HTTP);
  else if (!hsts) fail(g, "Strict-Transport-Security", "missing");
  else if (hsts.includes(",")) warn(g, "Strict-Transport-Security", `sent twice (${hsts}); turn HSTS off in aaPanel, the app sends it`);
  else {
    const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
    if (maxAge >= ONE_YEAR_S) pass(g, "Strict-Transport-Security", hsts);
    else fail(g, "Strict-Transport-Security", `max-age below one year: ${hsts}`);
  }

  const nosniff = h.get("x-content-type-options");
  if (nosniff?.toLowerCase() === "nosniff") pass(g, "X-Content-Type-Options", nosniff);
  else if (nosniff?.includes(",")) warn(g, "X-Content-Type-Options", `sent twice (${nosniff}); remove the proxy's add_header`);
  else fail(g, "X-Content-Type-Options", nosniff ? `unexpected: ${nosniff}` : "missing");

  const xfo = h.get("x-frame-options");
  if (xfo?.toUpperCase() === "DENY") pass(g, "X-Frame-Options", xfo);
  else if (xfo?.includes(",")) warn(g, "X-Frame-Options", `sent twice (${xfo}); remove the proxy's add_header`);
  else fail(g, "X-Frame-Options", xfo ? `unexpected: ${xfo}` : "missing");

  const referrer = h.get("referrer-policy");
  if (referrer) pass(g, "Referrer-Policy", referrer);
  else fail(g, "Referrer-Policy", "missing");

  const permissions = h.get("permissions-policy");
  if (permissions?.includes("camera=()")) pass(g, "Permissions-Policy", permissions);
  else fail(g, "Permissions-Policy", permissions ? `unexpected: ${permissions}` : "missing");

  const coop = h.get("cross-origin-opener-policy");
  if (coop === "same-origin") pass(g, "Cross-Origin-Opener-Policy", coop);
  else if (coop?.includes(",")) warn(g, "Cross-Origin-Opener-Policy", `sent twice (${coop}); remove the proxy's add_header`);
  else fail(g, "Cross-Origin-Opener-Policy", coop ? `unexpected: ${coop}` : "missing");

  const xpcdp = h.get("x-permitted-cross-domain-policies");
  if (xpcdp === "none") pass(g, "X-Permitted-Cross-Domain-Policies", xpcdp);
  else fail(g, "X-Permitted-Cross-Domain-Policies", xpcdp ? `unexpected: ${xpcdp}` : "missing");

  const powered = h.get("x-powered-by");
  if (powered) warn(g, "No X-Powered-By", `sent: ${powered}`);
  else pass(g, "No X-Powered-By", "not sent");

  const server = h.get("server");
  if (server && /\d/.test(server)) warn(g, "Server header hides the version", `${server}; aaPanel > App Store > Nginx > Settings > Config: server_tokens off`);
  else pass(g, "Server header hides the version", server ?? "not sent");
}

/** The path of an absolute URL, or null. */
function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

/** Absolute URLs listed in the sitemap (empty when it cannot be read). */
let sitemapUrls = [];

async function checkSitemapAndRobots() {
  const g = "SEO";
  const sm = await request("/sitemap.xml");
  sitemapUrls = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  if (sm.status !== 200 || !(sm.headers.get("content-type") ?? "").includes("xml")) {
    fail(g, "GET /sitemap.xml", `${describe(sm)}, content-type ${sm.headers.get("content-type") ?? "none"}`);
  } else if (sitemapUrls.length === 0) {
    fail(g, "GET /sitemap.xml", "no <loc> entries");
  } else {
    const foreign = sitemapUrls.filter((u) => {
      try {
        return new URL(u).origin !== ORIGIN;
      } catch {
        return true;
      }
    });
    if (foreign.length > 0) fail(g, "GET /sitemap.xml", `URLs use ${foreign[0]}, not ${ORIGIN}: APP_URL does not match the site`);
    else pass(g, "GET /sitemap.xml", `${sitemapUrls.length} URLs on ${ORIGIN}`);
  }

  const rb = await request("/robots.txt");
  if (rb.status !== 200) fail(g, "GET /robots.txt", describe(rb));
  else if (!/^Disallow:\s*\/admin\s*$/m.test(rb.text)) fail(g, "GET /robots.txt", "does not disallow /admin");
  else if (!rb.text.includes(`Sitemap: ${ORIGIN}/sitemap.xml`)) fail(g, "GET /robots.txt", `Sitemap line is not ${ORIGIN}/sitemap.xml (APP_URL)`);
  else pass(g, "GET /robots.txt", "disallows /admin, /account, /api; sitemap on this origin");
}

async function checkStorefront() {
  const g = "Pages";
  const paths = sitemapUrls.map(pathOf).filter(Boolean);
  const isChild = (p, parent) => p.startsWith(`${parent}/`) && p.split("/").length === 3;
  const product = paths.find((p) => isChild(p, "/software"));
  const guide = paths.find((p) => isChild(p, "/docs"));
  const pages = [...STOREFRONT_PAGES, ...(product ? [product] : []), ...(guide ? [guide] : [])];
  if (!product) warn(g, "A product page", "no /software/<slug> in the sitemap: is the catalog bootstrapped and published?");

  for (const path of pages) {
    const res = await request(path, { headers: { Accept: "text/html" } });
    if (path === "/") homeHtml = res.text;
    const type = res.headers.get("content-type") ?? "";
    const csp = res.headers.get("content-security-policy") ?? "";
    if (res.status !== 200) fail(g, `GET ${path}`, describe(res));
    else if (!type.includes("text/html")) fail(g, `GET ${path}`, `content-type ${type}`);
    else if (!csp.includes("frame-ancestors 'none'")) fail(g, `GET ${path}`, `200 but CSP missing or weak (${res.ms} ms)`);
    else if (path === "/checkout" && !csp.includes("https://checkout.razorpay.com")) {
      fail(g, `GET ${path}`, "CSP does not allow https://checkout.razorpay.com (payment modal would be blocked)");
    } else pass(g, `GET ${path}`, `200, CSP present, ${res.ms} ms`);
    if (path === "/") {
      if (res.status === 200) checkSecurityHeaders(res);
      else skip("Headers", "Security headers", "home page did not load");
    }
  }

  const canonical = /<link[^>]*rel="canonical"[^>]*>/i.exec(homeHtml)?.[0];
  const href = canonical ? /href="([^"]+)"/i.exec(canonical)?.[1] : null;
  if (!href) warn(g, "Canonical URL on /", "no canonical link found");
  else if (new URL(href, ORIGIN).origin !== ORIGIN) fail(g, "Canonical URL on /", `${href} is not on ${ORIGIN}: set APP_URL to ${ORIGIN}`);
  else pass(g, "Canonical URL on /", href);

  const asset = /(\/_next\/static\/[^"'\s?]+\.(?:js|css))/.exec(homeHtml)?.[1];
  if (!asset) {
    warn(g, "Static asset through the proxy", "no /_next/static asset found in the home page");
  } else {
    const res = await request(asset, { readBody: false });
    const cache = res.headers.get("cache-control") ?? "";
    if (res.status !== 200) fail(g, "Static asset through the proxy", `${asset}: ${describe(res)} (aaPanel static-file rules may be intercepting .js/.css)`);
    else if (!looksLikeDevServer && !cache.includes("immutable")) warn(g, "Static asset through the proxy", `200 but Cache-Control is "${cache}" (proxy overrides it)`);
    else if ((cache.match(/max-age=/gi) ?? []).length > 1) {
      warn(g, "Static asset through the proxy", `200 but two expiries in Cache-Control "${cache}": remove the proxy's expires rule for .js/.css`);
    } else pass(g, "Static asset through the proxy", `200, ${cache || "no cache-control"}`);
  }

  const missing = await request(`/smoke-test-missing-page-${Date.now()}`, { headers: { Accept: "text/html" } });
  if (missing.status === 404) pass(g, "Unknown page is 404", describe(missing));
  else fail(g, "Unknown page is 404", describe(missing));
}

/**
 * The dynamic pages carry the STRICT policy from middleware.ts (lib/security/csp.ts): a fresh nonce per response,
 * 'strict-dynamic' and no 'unsafe-inline' for scripts. /checkout also needs COOP same-origin-allow-popups (Razorpay's
 * bank and 3-D Secure windows report back to the opener).
 */
async function checkStrictCsp() {
  const g = "Strict CSP";
  for (const path of ["/sign-in", "/checkout"]) {
    const first = await request(path, { headers: { Accept: "text/html" } });
    const second = await request(path, { headers: { Accept: "text/html" } });
    const nonceOf = (res) => /'nonce-([^']+)'/.exec(cspDirectives(res.headers.get("content-security-policy")).get("script-src")?.join(" ") ?? "")?.[1];
    const script = cspDirectives(first.headers.get("content-security-policy")).get("script-src") ?? [];
    const name = `${path} has the strict nonce policy`;
    if (first.status !== 200) fail(g, name, describe(first));
    else if (!nonceOf(first) || !script.includes("'strict-dynamic'")) fail(g, name, `script-src is ${script.join(" ") || "missing"}`);
    else if (script.includes("'unsafe-inline'")) fail(g, name, "script-src still allows 'unsafe-inline'");
    else if (nonceOf(first) === nonceOf(second)) fail(g, name, "the nonce repeats between responses (a proxy or CDN caches the page)");
    else if (!first.text.includes(`nonce="${nonceOf(first)}"`)) fail(g, name, "the page's scripts do not carry the nonce");
    else pass(g, name, "fresh nonce per response, 'strict-dynamic', no 'unsafe-inline'");
    if (path === "/checkout") {
      const coop = first.headers.get("cross-origin-opener-policy");
      if (coop === "same-origin-allow-popups") pass(g, "/checkout COOP allows the payment popups", coop);
      else fail(g, "/checkout COOP allows the payment popups", coop ? `unexpected: ${coop}` : "missing");
    }
  }
}

async function checkAuthGates() {
  const g = "Auth";
  const me = await request("/api/me", { headers: { Accept: "application/json" } });
  if (me.status === 401) pass(g, "GET /api/me signed out is 401", describe(me));
  else fail(g, "GET /api/me signed out is 401", describe(me));

  for (const path of ["/admin", "/account"]) {
    const name = `${path} redirects to /sign-in`;
    const res = await request(path, { headers: { Accept: "text/html" }, readBody: false });
    const loc = locationOf(res);
    if (![302, 303, 307, 308].includes(res.status) || !loc) {
      fail(g, name, `${describe(res)} (expected a redirect)`);
    } else if (loc.origin !== BASE && loc.origin !== ORIGIN) {
      fail(g, name, `redirects to ${loc.origin}: APP_URL in shared/.env.production must be exactly the public https origin (the sign-in redirect is built on it); restart after fixing it`);
    } else if (loc.pathname !== "/sign-in" || loc.searchParams.get("next") !== path) {
      fail(g, name, `redirects to ${loc.pathname}${loc.search}`);
    } else pass(g, name, `${res.status} -> ${loc.pathname}${loc.search}`);
  }
}

async function checkDevRoutesHidden() {
  const g = "Dev routes";
  const probes = [
    ["GET", "/dev/ui"],
    ["GET", "/dev/mailbox"],
    ["GET", "/dev/mock-checkout"],
    ["GET", "/api/dev/storage/smoke-test.txt"],
    ["GET", "/api/dev/mailbox/console-smoke/attachments/0"],
    ["POST", "/api/dev/mock-checkout"],
  ];
  for (const [method, path] of probes) {
    const name = `${method} ${path} is 404`;
    if (looksLikeDevServer && !IS_HTTPS) {
      skip(g, name, "development server: these routes exist there by design");
      continue;
    }
    const res = await request(path, { method, headers: { Accept: "text/html" }, body: method === "POST" ? "{}" : undefined, readBody: false });
    if (res.status === 404) pass(g, name, describe(res));
    else fail(g, name, `${describe(res)}${looksLikeDevServer ? " (development build: NODE_ENV is not production)" : ""}`);
  }
}

/** Files that exist in the release folder and must never be served (the website root is not the app folder). */
const PRIVATE_FILES = ["/.env", "/.env.production", "/.git/HEAD", "/package.json", "/prisma/schema.prisma", "/deploy/deploy.sh"];

async function checkPrivateFiles() {
  const g = "Exposure";
  const served = [];
  const odd = [];
  for (const path of PRIVATE_FILES) {
    const res = await request(path, { headers: { Accept: "*/*" }, readBody: false });
    if (res.status === 200 || res.status === 206) served.push(path);
    else if (![401, 403, 404, 410].includes(res.status)) odd.push(`${path} ${describe(res)}`);
  }
  const name = "Env and source files are not served";
  if (served.length > 0) {
    fail(g, name, `served: ${served.join(", ")}. The aaPanel site root must not be the app folder, and everything must go through the proxy`);
  } else if (odd.length > 0) warn(g, name, `unexpected answers: ${odd.join("; ")}`);
  else pass(g, name, `${PRIVATE_FILES.length} paths refused (404/403)`);
}

/** Admin > Settings > Branding files (docs/security.md "Branding uploads"). */
const BRAND_ASSET_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

async function checkBranding() {
  const g = "Branding";
  for (const slot of ["logo-light", "logo-dark", "favicon"]) {
    const res = await request(`/brand/${slot}`, { readBody: false });
    const name = `GET /brand/${slot}`;
    if (res.error || ![200, 404].includes(res.status)) {
      fail(g, name, describe(res));
      continue;
    }
    const problems = [];
    if (res.headers.get("content-security-policy") !== BRAND_ASSET_CSP) problems.push(`CSP is "${res.headers.get("content-security-policy") ?? "missing"}"`);
    if (res.headers.get("x-content-type-options") !== "nosniff") problems.push("no nosniff");
    if (res.status === 200) {
      const type = res.headers.get("content-type") ?? "";
      if (!/^image\/(png|webp|svg\+xml|x-icon)$/.test(type)) problems.push(`Content-Type ${type || "missing"}`);
      if (!(res.headers.get("content-disposition") ?? "").startsWith("inline")) problems.push("not inline");
    }
    if (problems.length > 0) fail(g, name, problems.join("; "));
    else pass(g, name, res.status === 404 ? "404: nothing uploaded (built-in look)" : `200 ${res.headers.get("content-type")}, sandboxed`);
  }
  const junk = await request("/brand/logo-light.svg", { readBody: false });
  if (junk.status === 404) pass(g, "Other /brand names are 404", "404");
  else fail(g, "Other /brand names are 404", describe(junk));
}

async function checkCron() {
  const g = "Cron";
  for (const path of ["/api/cron/emails", "/api/cron/reconcile", "/api/cron/renewals", "/api/cron/maintenance"]) {
    const res = await request(path, { headers: { Accept: "application/json" } });
    const name = `GET ${path} without the secret is refused`;
    if (res.status === 401) pass(g, name, "401 (secret required)");
    else if (res.status === 403 || res.status === 404) pass(g, name, `${res.status} (blocked at the proxy)`);
    else fail(g, name, describe(res));
  }
}

async function checkWebhooks() {
  const g = "Webhooks";
  // A made-up event with a wrong signature. The server answers 401 and records nothing but a bookkeeping row.
  const body = JSON.stringify({ entity: "event", event: "smoke.test", payload: {} });
  const headers = {
    "Content-Type": "application/json",
    "X-Razorpay-Signature": "0".repeat(64),
    "X-Razorpay-Event-Id": `smoke_${Date.now()}`,
  };
  const res = await request(`/api/webhooks/payments/${PROVIDER}`, { method: "POST", headers, body });
  const name = `POST /api/webhooks/payments/${PROVIDER} bad signature is 401`;
  if (res.status === 401 && errorCode(res) === "invalid_signature") pass(g, name, describe(res));
  else if (res.status === 503 && errorCode(res) === "payments_not_configured") {
    warn(g, name, "payments are not configured yet (Admin > Settings > Integrations)");
  } else if (res.status === 404) fail(g, name, `404: the server's payment provider is not "${PROVIDER}" (or pass --provider ...)`);
  else if (res.status === 413) fail(g, name, "413: the proxy refuses the body (client_max_body_size)");
  else fail(g, name, `${describe(res)} ${errorCode(res) ?? ""}`.trim());

  if (PROVIDER !== "mock") {
    const mock = await request("/api/webhooks/payments/mock", { method: "POST", headers, body });
    if (mock.status === 404) pass(g, "Mock provider webhook is 404", describe(mock));
    else fail(g, "Mock provider webhook is 404", `${describe(mock)}: the mock payment provider may be active`);
  }
}

/** 4xx is the right answer to junk input; 5xx is a server problem (503: Redis or the database is unreachable). */
function judgeDeviceApi(g, name, res, expected) {
  const code = errorCode(res);
  const detail = `${describe(res)}${code ? ` ${code}` : ""}`;
  const noStore = (res.headers.get("cache-control") ?? "").includes("no-store");
  if (expected.includes(res.status) && noStore) pass(g, name, detail);
  else if (expected.includes(res.status)) warn(g, name, `${detail}, but Cache-Control is not no-store (proxy cache on?)`);
  else if (res.status === 429) warn(g, name, `${detail}: rate limited, run again in a minute`);
  else if (res.status === 503) fail(g, name, `${detail}: Redis or the database is unreachable (rate limits fail closed)`);
  else fail(g, name, detail);
}

async function checkDeviceApi() {
  const g = "Device API";
  const headers = { "Content-Type": "application/json", Accept: "application/json", "X-App-Id": "ZZZ" };
  const validate = await request("/api/v1/licenses/validate", {
    method: "POST",
    headers,
    body: JSON.stringify({ activationToken: "smoke.invalid.token", deviceFingerprint: FINGERPRINT, appVersion: "0.0.1" }),
  });
  judgeDeviceApi(g, "validate with a junk token is 4xx", validate, [400, 401, 422]);

  // Malformed on purpose (the letter O and the digit 0 are not in the key alphabet), so it can never match a license.
  const activate = await request("/api/v1/licenses/activate", {
    method: "POST",
    headers,
    body: JSON.stringify({
      licenseKey: "ZZZ-OOOO-0000-OOOO-0000",
      deviceFingerprint: FINGERPRINT,
      deviceName: "Smoke test",
      os: "Smoke test",
      appVersion: "0.0.1",
    }),
  });
  judgeDeviceApi(g, "activate with a junk key is 404", activate, [404]);

  const noAppId = await request("/api/v1/licenses/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: "{}",
  });
  judgeDeviceApi(g, "request without X-App-Id is 400", noAppId, [400]);
}

// ---------------------------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------------------------

function printTable() {
  const rows = results.map((r) => [r.status, `${r.group}: ${r.name}`, r.detail]);
  const w0 = 6;
  const w1 = Math.min(60, Math.max(5, ...rows.map((r) => r[1].length)));
  const line = `${"-".repeat(w0)}  ${"-".repeat(w1)}  ${"-".repeat(40)}`;
  const target = ORIGIN === BASE ? BASE : `${BASE} (public origin ${ORIGIN})`;
  const out = [`Smoke test of ${target} (${new Date().toISOString()})`, "", `${"RESULT".padEnd(w0)}  ${"CHECK".padEnd(w1)}  DETAIL`, line];
  for (const [status, name, detail] of rows) {
    out.push(`${status.padEnd(w0)}  ${name.length > w1 ? `${name.slice(0, w1 - 1)}~` : name.padEnd(w1)}  ${detail}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  out.push(line, `${count("PASS")} passed, ${count("FAIL")} failed, ${count("WARN")} warnings, ${count("SKIP")} skipped`);
  if (looksLikeDevServer) out.push("Note: this looks like a development server (CSP allows 'unsafe-eval'); dev-only routes are reachable there.");
  if (count("FAIL") > 0) out.push("Result: FAILED. Fix the FAIL rows (docs/go-live-checklist.md says how to check each one), then run again.");
  else out.push("Result: OK (no failures). Read the WARN rows, if any.");
  console.info(out.join("\n"));
}

async function main() {
  await checkTls();
  await checkDns();
  await checkWww();
  await checkHealth();
  await checkSitemapAndRobots();
  await checkStorefront();
  await checkStrictCsp();
  await checkAuthGates();
  await checkDevRoutesHidden();
  await checkPrivateFiles();
  await checkBranding();
  await checkCron();
  await checkWebhooks();
  await checkDeviceApi();

  const failed = results.some((r) => r.status === "FAIL");
  if (JSON_OUT) console.info(JSON.stringify({ base: BASE, origin: ORIGIN, at: new Date().toISOString(), ok: !failed, results }, null, 2));
  else printTable();
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(`Smoke test crashed: ${e?.stack ?? e}`);
  process.exitCode = 1;
});
