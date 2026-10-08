/**
 * Deploy preflight (deploy.sh step "Check the environment, PostgreSQL and Redis"). Run in a release folder:
 *
 *   NODE_ENV=production node --import tsx deploy/preflight.mjs [--db] [--redis] [--first-run] [--dir <release>]
 *
 * - Loads the env files exactly like `next start` does (@next/env) and refuses any file other than .env.production
 *   (.env, .env.local and .env.production.local would silently override shared/.env.production).
 * - Refuses every value that still contains CHANGE-ME (the placeholders of deploy/.env.production.example; lib/env.ts
 *   only catches placeholders in secrets, not in APP_URL, SMTP_HOST, SES_REGION or BOOTSTRAP_OWNER_EMAIL).
 * - Validates the result with lib/env.ts parseEnv() under the production rules (https APP_URL, REDIS_URL,
 *   TRUSTED_PROXY_HOPS >= 1, CATALOG_SOURCE=db, no mock / local / console driver, ...).
 * - Payments, email and storage are normally saved in Admin > Settings > Integrations, so none of their variables is
 *   required. One line per integration says what the env fallback holds (lib/integrations/env-source.ts; email:
 *   smtp, or ses with its region); values that cannot work (the release-day stand-ins, an .invalid host, a malformed
 *   Key ID, an SES region without SES, values without their PAYMENT_PROVIDER / EMAIL_TRANSPORT / STORAGE_DRIVER
 *   line) are a WARNING, not a failure: the app starts and shows
 *   the integration as "Not configured" until it is saved in Admin. CHANGE-ME values still fail (see above).
 * - --first-run: BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD must be set (the bootstrap checks the rest).
 * - --db: connects with DATABASE_URL; needs PostgreSQL 14+ and a UTF8 database (collation C recommended); lists the
 *   integrations saved in Admin (kind and date only; a missing table means the migration is still pending).
 * - --redis: PING through REDIS_URL.
 * Prints variable names, rules and server facts only, never a value. Exit 0 when everything passed, 1 otherwise.
 */
import nextEnv from "@next/env";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const dirArg = args.indexOf("--dir");
const dir = resolve(dirArg >= 0 && args[dirArg + 1] ? args[dirArg + 1] : process.cwd());
const PLACEHOLDER = /change-?me/i;

const problems = [];
const warnings = [];
const info = (message) => console.info(`preflight: ${message}`);

function finish() {
  for (const w of warnings) console.warn(`preflight: WARNING ${w}`);
  if (problems.length > 0) {
    console.error(`preflight: FAILED (${problems.length} problem${problems.length === 1 ? "" : "s"}):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  info("all checks passed");
  process.exit(0);
}

if (process.env.NODE_ENV !== "production") {
  problems.push("NODE_ENV: run the preflight with NODE_ENV=production (deploy.sh does)");
  finish();
}

const shellKeys = new Set(Object.keys(process.env));
const quiet = { info() {}, error(...parts) { console.error(...parts.map((p) => (p instanceof Error ? p.message : p))); } };
const { loadedEnvFiles } = nextEnv.loadEnvConfig(dir, false, quiet, true);
const names = loadedEnvFiles.map((f) => relative(dir, resolve(dir, f.path)).replace(/^[.][/]/, ""));
const prodFile = loadedEnvFiles.find((f) => names[loadedEnvFiles.indexOf(f)] === ".env.production");
for (const name of names) {
  if (name !== ".env.production") problems.push(`${name}: Next.js loads this file too and it overrides values; delete it from the release (only shared/.env.production belongs there)`);
}
if (!prodFile) {
  problems.push(".env.production: not found in the release (deploy.sh links it to shared/.env.production)");
  finish();
}

const fileKeys = Object.keys(prodFile.env);
info(`.env.production: ${fileKeys.length} variables`);
for (const key of fileKeys) {
  if (PLACEHOLDER.test(prodFile.env[key] ?? "")) problems.push(`${key}: still has the CHANGE-ME placeholder; fill in the real value`);
  if (shellKeys.has(key)) warnings.push(`${key} is also set in the shell environment, which wins over the file for this command`);
}

let env = null;
try {
  const mod = await import(pathToFileURL(resolve(dir, "lib", "env.ts")).href);
  const parseEnv = mod.parseEnv ?? mod.default?.parseEnv;
  env = parseEnv(process.env);
} catch (error) {
  if (Array.isArray(error?.problems)) problems.push(...error.problems);
  else problems.push(`lib/env.ts could not be loaded (${error instanceof Error ? error.message : "unknown error"}); run with node --import tsx`);
}
if (env) info(`environment valid for production (APP_URL ${new URL(env.APP_URL).origin})`);

/** One line per integration: what the env fallback holds. Names only, never values. */
if (env) {
  try {
    const mod = await import(pathToFileURL(resolve(dir, "lib", "integrations", "env-source.ts")).href);
    const classify = mod.classifyEnvIntegrations ?? mod.default?.classifyEnvIntegrations;
    const verdicts = classify(process.env, { production: true });
    for (const kind of ["payments", "email", "storage"]) {
      const { selector, result } = verdicts[kind];
      if (result.ok) {
        const email = kind === "email" ? result.config : null;
        const what =
          kind === "payments"
            ? `${result.config.provider} (${result.config.mode} mode)`
            : email
              ? `${email.transport}${email.transport === "ses" ? ` (${email.region})` : ""}`
              : result.config.driver;
        info(`${kind}: server file ${what} (used while nothing is saved in Admin)`);
      } else if (result.reason === "missing") {
        info(`${kind}: not in the server file (set it in Admin > Settings > Integrations)`);
      } else {
        const names = result.names.length > 0 ? `: ${result.names.join(", ")}` : "";
        const why = result.reason === "env_incomplete" ? "is incomplete" : result.reason === "unsupported_provider" ? `selects an unsupported provider (${selector})` : "has values that can't work";
        info(`${kind}: server file ${why}${names} (ignored)`);
        warnings.push(`${kind}: the server file ${why}${names}; set ${kind} in Admin > Settings > Integrations, then delete those lines`);
      }
    }
  } catch (error) {
    warnings.push(`integrations: lib/integrations/env-source.ts could not be loaded (${error instanceof Error ? error.message : "unknown error"})`);
  }
}

const ownerEmail = process.env.BOOTSTRAP_OWNER_EMAIL?.trim();
const ownerPassword = process.env.BOOTSTRAP_OWNER_PASSWORD ?? "";
if (flag("first-run")) {
  if (!ownerEmail) problems.push("BOOTSTRAP_OWNER_EMAIL: is required for --first-run (the first Owner's real mailbox)");
  if (!ownerPassword) problems.push("BOOTSTRAP_OWNER_PASSWORD: is required for --first-run");
} else if (ownerPassword) {
  warnings.push("BOOTSTRAP_OWNER_PASSWORD is still in .env.production; delete that line once the Owner can sign in");
}

if (env?.APP_URL && new URL(env.APP_URL).hostname.startsWith("www.")) {
  warnings.push("APP_URL uses www.; deploy/aapanel-nginx.conf redirects www to the bare domain, so remove that redirect");
}

if (env && flag("db")) {
  // tsx hands dynamic imports of CommonJS packages back without a default export; plain Node adds one.
  const pgModule = await import("pg");
  const pg = pgModule.default ?? pgModule;
  const url = new URL(env.DATABASE_URL);
  if (url.searchParams.has("schema")) warnings.push("DATABASE_URL has ?schema=; production should not (docs/scaling.md)");
  url.searchParams.delete("schema");
  const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000, statement_timeout: 5000 });
  client.on("error", () => {});
  try {
    await client.connect();
    const { rows } = await client.query(
      `SELECT current_setting('server_version_num')::int AS num, current_setting('server_version') AS version,
              pg_encoding_to_char(d.encoding) AS encoding, d.datcollate AS collate, d.datctype AS ctype
         FROM pg_database d WHERE d.datname = current_database()`,
    );
    const row = rows[0];
    info(`PostgreSQL ${row.version}, database encoding ${row.encoding}, collation ${row.collate}`);
    if (row.num < 140000) problems.push(`DATABASE_URL: PostgreSQL ${row.version} is too old (14 or newer)`);
    if (row.encoding !== "UTF8") {
      problems.push(`DATABASE_URL: the database encoding is ${row.encoding}; it must be UTF8. Recreate it while empty (deploy/db-setup.sh): ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0`);
    }
    if (row.collate !== "C" || row.ctype !== "C") warnings.push(`database collation ${row.collate} / ctype ${row.ctype}; C / C is recommended (deploy/db-setup.sh)`);
    try {
      const saved = await client.query(`SELECT kind::text AS kind, "updatedAt" AS "updatedAt" FROM "IntegrationConfig" ORDER BY kind`);
      if (saved.rows.length === 0) info("Admin: no integrations saved yet");
      for (const r of saved.rows) info(`Admin: ${String(r.kind).toLowerCase()} saved ${new Date(r.updatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`);
    } catch (error) {
      if (error?.code === "42P01") info("Admin: none yet (migration pending)");
      else warnings.push(`Admin integrations: could not be listed (${error?.code ?? "unknown error"})`);
    }
  } catch (error) {
    problems.push(`DATABASE_URL: cannot connect or query (${error?.code ? `${error.code} ` : ""}${error instanceof Error ? error.message : "unknown error"})`);
  } finally {
    await client.end().catch(() => {});
  }
}

if (env && flag("redis") && env.REDIS_URL) {
  const ioredis = await import("ioredis");
  const Redis = ioredis.Redis ?? ioredis.default?.Redis ?? ioredis.default;
  const parsed = new URL(env.REDIS_URL);
  if (!parsed.password) warnings.push("REDIS_URL has no password; set requirepass in Redis and put it in the URL");
  const redis = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 5000,
    commandTimeout: 5000,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
  // ioredis rejects with "Connection is closed."; the error event carries the reason (ECONNREFUSED, WRONGPASS, ...).
  let lastError = null;
  redis.on("error", (error) => {
    lastError = error;
  });
  try {
    await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error(`unexpected answer to PING`);
    info(`Redis PING ok (${parsed.hostname}:${parsed.port || "6379"})`);
  } catch (error) {
    const reason = lastError instanceof Error ? lastError.message : error instanceof Error ? error.message : "unknown error";
    problems.push(`REDIS_URL: no PONG (${reason}); is Redis running with that password?`);
  } finally {
    redis.disconnect();
  }
}

finish();
