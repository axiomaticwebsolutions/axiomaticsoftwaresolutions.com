/**
 * Writes the production env file from deploy/.env.production.example with fresh secrets (deploy/README.md).
 * Run it ON THE SERVER, once, before the first deploy:
 *
 *   node scripts/gen-prod-env.mjs --out /www/wwwroot/axiomatic/shared/.env.production [--force]
 *
 * Generated (cryptographically random): SESSION_SECRET, CSRF_SECRET, ORDER_TOKEN_SECRET, CRON_SECRET,
 * LICENSE_KEY_PEPPER, LICENSE_KEY_ENC_KEY, the Ed25519 LICENSE_SIGNING_PRIVATE_KEY / LICENSE_SIGNING_PUBLIC_KEY pair
 * (one line each, line breaks written as a literal backslash + n), BOOTSTRAP_OWNER_PASSWORD, and the passwords inside
 * DATABASE_URL and REDIS_URL (letters and digits only, so they never need URL encoding; deploy/db-setup.sh and Redis'
 * requirepass use them).
 * Every other line keeps the example's value. Values that still contain CHANGE-ME must be filled in by hand; the
 * script lists their names, and deploy.sh refuses to deploy while one is left.
 * Payments, storage and email are not generated: they are saved in Admin > Settings > Integrations after the first
 * sign-in (the Razorpay webhook secret is the one you choose in the Razorpay Dashboard). Their env lines are a
 * commented-out fallback in the template.
 *
 * The file is written with mode 600 (new temp file + rename). Prints variable names only, never a value.
 * Refuses to replace an existing file unless --force. WARNING: replacing the file of a server that already issued
 * license keys makes those keys unverifiable (new LICENSE_KEY_PEPPER / LICENSE_KEY_ENC_KEY), signs out trusted
 * devices and breaks the database and Redis logins until they get the new passwords. Plain Node 20.19+, no packages.
 */
import { generateKeyPairSync, randomBytes, randomInt } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = [
  "Usage: node scripts/gen-prod-env.mjs --out <file> [--force] [--example <file>]",
  "",
  "  --out <file>      where to write, e.g. /www/wwwroot/axiomatic/shared/.env.production (required)",
  "  --force           replace an existing file (see the warning in this script's header first)",
  "  --example <file>  template (default deploy/.env.production.example next to this script)",
].join("\n");

function parseArgs(argv) {
  const out = { out: "", force: false, example: join(root, "deploy", ".env.production.example"), help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      i += 1;
      if (argv[i] === undefined || argv[i].startsWith("--")) fail(`${name} needs a value`);
      return argv[i];
    };
    if (name === "--out") out.out = value();
    else if (name === "--example") out.example = value();
    else if (name === "--force") out.force = true;
    else if (name === "--help" || name === "-h") out.help = true;
    else fail(`unknown argument "${arg}"`);
  }
  return out;
}

function fail(message) {
  console.error(`gen-prod-env: ${message}\n\n${USAGE}`);
  process.exit(1);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.info(USAGE);
  process.exit(0);
}
if (!opts.out) fail("--out is required");

// Never a value that lib/env.ts or deploy/preflight.mjs would mistake for a placeholder (astronomically unlikely).
const PLACEHOLDER_LIKE = /change-?me|x{8,}|[.][.][.]/i;
function fresh(make) {
  for (;;) {
    const value = make();
    if (!PLACEHOLDER_LIKE.test(value)) return value;
  }
}
const hex = (bytes) => fresh(() => randomBytes(bytes).toString("hex"));
const b64 = (bytes) => fresh(() => randomBytes(bytes).toString("base64"));
const b64url = (bytes) => fresh(() => randomBytes(bytes).toString("base64url"));

/** 4 groups of 5 from an unambiguous alphabet (about 116 bits), with a letter and a digit (the password policy). */
function ownerPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  for (;;) {
    const groups = Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join(""));
    const password = groups.join("-");
    if (/[A-Za-z]/.test(password) && /[0-9]/.test(password) && !PLACEHOLDER_LIKE.test(password)) return password;
  }
}

// One line per PEM: dotenv expands the escaped line breaks inside double quotes, lib/env.ts accepts them either way.
const NEWLINE_ESCAPE = String.fromCharCode(92) + "n";
const pemLine = (pem) => `"${pem.trim().split(/\r?\n/).join(NEWLINE_ESCAPE)}"`;
const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** Whole values replaced by fresh ones. */
const generated = {
  SESSION_SECRET: b64url(64),
  CSRF_SECRET: b64url(32),
  ORDER_TOKEN_SECRET: b64url(32),
  CRON_SECRET: b64url(32),
  LICENSE_KEY_PEPPER: hex(32),
  LICENSE_KEY_ENC_KEY: b64(32),
  LICENSE_SIGNING_PRIVATE_KEY: pemLine(privateKey),
  LICENSE_SIGNING_PUBLIC_KEY: pemLine(publicKey),
  BOOTSTRAP_OWNER_PASSWORD: ownerPassword(),
};
/** Placeholders replaced inside a value (the rest of the URL stays as in the example). */
const embedded = {
  DATABASE_URL: { token: "CHANGE-ME-DB-PASSWORD", value: hex(24) },
  REDIS_URL: { token: "CHANGE-ME-REDIS-PASSWORD", value: hex(24) },
};

let example;
try {
  example = readFileSync(resolve(opts.example), "utf8");
} catch {
  fail(`cannot read the template ${opts.example}`);
}

const LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const seen = new Set();
const lines = example.split(/\r?\n/).map((line) => {
  const m = LINE.exec(line);
  if (!m) return line;
  const [, key, value] = m;
  seen.add(key);
  if (key in generated) return `${key}=${generated[key]}`;
  const swap = embedded[key];
  if (swap) {
    if (!value.includes(swap.token)) fail(`${key} in the template has no ${swap.token} placeholder`);
    return `${key}=${value.split(swap.token).join(swap.value)}`;
  }
  return line;
});
const missing = [...Object.keys(generated), ...Object.keys(embedded)].filter((key) => !seen.has(key));
if (missing.length > 0) fail(`the template lacks ${missing.join(", ")}`);

// Names of the values the operator still has to fill in (CHANGE-ME left in an uncommented assignment).
const todo = [];
for (const line of lines) {
  const m = LINE.exec(line);
  if (m && /change-?me/i.test(m[2])) todo.push(m[1]);
}

const out = resolve(opts.out);
let exists = false;
try {
  lstatSync(out);
  exists = true;
} catch {
  exists = false;
}
if (exists && !opts.force) {
  fail(`${out} already exists; nothing written. Use --force only if that file was never used by a running server.`);
}

mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
const tmp = `${out}.tmp-${process.pid}`;
try {
  writeFileSync(tmp, `${lines.join("\n").replace(/\n+$/, "")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, out);
} catch (error) {
  rmSync(tmp, { force: true });
  fail(`could not write ${out} (${error instanceof Error ? error.message : "unknown error"})`);
}

const generatedNames = [...Object.keys(generated), "DATABASE_URL (password)", "REDIS_URL (password)"];
console.info(`gen-prod-env: ${exists ? "REPLACED" : "wrote"} ${out} (mode 600). Values are not printed.`);
console.info(`gen-prod-env: fresh values for ${generatedNames.join(", ")}.`);
if (todo.length > 0) {
  console.info(`gen-prod-env: fill in by hand (they still contain CHANGE-ME): ${todo.join(", ")}.`);
}
console.info("gen-prod-env: next: keep a copy in your password manager, create the database role (deploy/db-setup.sh)");
console.info("gen-prod-env: and set Redis requirepass to the password inside REDIS_URL (deploy/README.md).");
console.info("gen-prod-env: payments, email and storage are set later in Admin > Settings > Integrations.");
