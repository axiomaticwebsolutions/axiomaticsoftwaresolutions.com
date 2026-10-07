/**
 * Writes .env.local from .env.example with fresh random development secrets.
 * Usage: pnpm secrets            (refuses to overwrite an existing .env.local)
 *        pnpm secrets --force    (overwrites; WARNING: invalidates seeded license keys and sessions)
 *        pnpm secrets --rotate-signing   (replaces only the Ed25519 activation-token key pair in .env.local;
 *                                         license keys, sessions and seed passwords keep working)
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const target = join(root, ".env.local");
const force = process.argv.includes("--force");
const rotateSigning = process.argv.includes("--rotate-signing");

if (existsSync(target) && !force && !rotateSigning) {
  console.error(".env.local already exists. Re-run with --force to replace it (this breaks existing seeded keys).");
  process.exit(1);
}

const hex = (n: number) => randomBytes(n).toString("hex");
const b64 = (n: number) => randomBytes(n).toString("base64");
const b64url = (n: number) => randomBytes(n).toString("base64url");
// One line per value: newlines become a literal backslash + "n", which dotenv / @next/env expand back.
const NEWLINE_ESCAPE = String.fromCharCode(92) + "n";
const pemEscaped = (pem: string) => `"${pem.trim().split(/\r?\n/).join(NEWLINE_ESCAPE)}"`;

const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const generated: Record<string, string> = {
  SESSION_SECRET: b64url(64),
  CSRF_SECRET: b64url(32),
  ORDER_TOKEN_SECRET: b64url(32),
  CRON_SECRET: b64url(32),
  LICENSE_KEY_PEPPER: hex(32),
  LICENSE_KEY_ENC_KEY: b64(32),
  LICENSE_SIGNING_PRIVATE_KEY: pemEscaped(privateKey),
  LICENSE_SIGNING_PUBLIC_KEY: pemEscaped(publicKey),
  PAYMENT_PROVIDER: "mock",
  PAYMENT_KEY_ID: "mock_key",
  PAYMENT_KEY_SECRET: b64url(24),
  PAYMENT_WEBHOOK_SECRET: b64url(32),
  STORAGE_DRIVER: "local",
  STORAGE_ACCESS_KEY_ID: "",
  STORAGE_SECRET_ACCESS_KEY: "",
  EMAIL_TRANSPORT: "console",
  SEED_OWNER_PASSWORD: `Owner-${b64url(9)}1`,
  SEED_DEMO_PASSWORD: `Demo-${b64url(9)}1`,
};

if (rotateSigning) {
  if (!existsSync(target)) {
    console.error(".env.local does not exist yet. Run `pnpm secrets` first.");
    process.exit(1);
  }
  const signingKeys = new Set(["LICENSE_SIGNING_PRIVATE_KEY", "LICENSE_SIGNING_PUBLIC_KEY"]);
  const kept: string[] = [];
  let skipping = false;
  for (const line of readFileSync(target, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (m) skipping = signingKeys.has(m[1]!);
    // Lines that are not variables or comments are continuation lines of a multi-line value: drop them with it.
    else if (skipping || (line.trim() !== "" && !line.startsWith("#"))) continue;
    if (!skipping) kept.push(line);
  }
  kept.push(`LICENSE_SIGNING_PRIVATE_KEY=${generated.LICENSE_SIGNING_PRIVATE_KEY}`);
  kept.push(`LICENSE_SIGNING_PUBLIC_KEY=${generated.LICENSE_SIGNING_PUBLIC_KEY}`);
  writeFileSync(target, kept.join("\n"), { encoding: "utf8", mode: 0o600 });
  console.info("Rotated the Ed25519 activation-token key pair in .env.local (values not printed).");
  process.exit(0);
}

const example = readFileSync(join(root, ".env.example"), "utf8");
const seen = new Set<string>();
const out = example.split(/\r?\n/).map((line) => {
  const m = /^([A-Z0-9_]+)=/.exec(line);
  if (!m) return line;
  const key = m[1]!;
  seen.add(key);
  if (!(key in generated)) return line;
  // Drop the trailing comment so generated values are never confused with placeholders.
  return `${key}=${generated[key]}`;
});

for (const key of Object.keys(generated)) {
  if (!seen.has(key)) out.push(`${key}=${generated[key]}`);
}

writeFileSync(target, out.join("\n"), { encoding: "utf8", mode: 0o600 });
console.info(`Wrote ${target} with fresh development secrets.`);
console.info("Seed login passwords are in SEED_OWNER_PASSWORD and SEED_DEMO_PASSWORD inside .env.local.");
