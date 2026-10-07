/**
 * Development only: writes a small text placeholder, labelled "SAMPLE installer placeholder", under STORAGE_LOCAL_DIR
 * (default .storage) for every ReleaseFile.storageKey in the database, so the local storage driver can serve real
 * downloads through /api/dev/storage. Idempotent: files that already hold the placeholder are left alone.
 *   node scripts/storage-seed.mjs        (requested as `pnpm storage:seed`)
 * Reads DATABASE_URL (honours ?schema=), STORAGE_DRIVER and STORAGE_LOCAL_DIR from .env / .env.local via @next/env.
 * Refuses NODE_ENV=production and STORAGE_DRIVER other than local. Prints counts only.
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";
import pg from "pg";

// Same rule as isStorageKey() in lib/storage/types.ts: "/"-separated segments that start with a letter or digit.
const STORAGE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:[/][A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MAX_STORAGE_KEY_LENGTH = 512;
const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

function fail(message) {
  console.error(`storage:seed: ${message}`);
  process.exit(1);
}

nextEnv.loadEnvConfig(process.cwd(), true, { info: () => {}, error: (...args) => console.error(...args) });

if (process.env.NODE_ENV === "production") fail("development only (NODE_ENV=production).");
const driver = process.env.STORAGE_DRIVER ?? "local";
if (driver !== "local") fail(`STORAGE_DRIVER is "${driver}"; placeholders are only written for the local driver.`);
if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set (run `pnpm secrets` or edit .env.local).");

const root = path.resolve(process.env.STORAGE_LOCAL_DIR || ".storage");

/** pg connection settings from DATABASE_URL, with ?schema= turned into the session search_path (as lib/db.ts does). */
function connectionFrom(url) {
  const parsed = new URL(url);
  const schema = parsed.searchParams.get("schema");
  parsed.searchParams.delete("schema");
  parsed.searchParams.delete("options");
  if (schema && !SCHEMA_RE.test(schema)) fail("DATABASE_URL ?schema= must be a plain identifier.");
  return schema ? { connectionString: parsed.toString(), options: `-c search_path="${schema}"` } : { connectionString: parsed.toString() };
}

function placeholderFor(row) {
  return [
    "SAMPLE installer placeholder",
    "",
    "This is not a real installer. Axiomatic development storage serves this text file in place of the",
    "installer below so download links can be tested end to end. Real installers are uploaded to S3.",
    "",
    `File: ${row.fileName}`,
    `Platform: ${row.platform}`,
    `Storage key: ${row.storageKey}`,
    `Release file id: ${row.id}`,
    "",
  ].join("\n");
}

function targetPath(key) {
  if (typeof key !== "string" || key.length > MAX_STORAGE_KEY_LENGTH || !STORAGE_KEY_RE.test(key)) return null;
  const full = path.resolve(root, ...key.split("/"));
  return full.startsWith(root + path.sep) ? full : null;
}

async function writeIfChanged(file, content) {
  const existing = await fs.readFile(file, "utf8").catch(() => null);
  if (existing === content) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await fs.writeFile(temp, content, "utf8");
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  return true;
}

async function main() {
  const client = new pg.Client(connectionFrom(process.env.DATABASE_URL));
  await client.connect();
  let rows;
  try {
    ({ rows } = await client.query(
      'SELECT "id", "platform", "fileName", "storageKey" FROM "ReleaseFile" ORDER BY "storageKey", "id"',
    ));
  } finally {
    await client.end();
  }

  let written = 0;
  let unchanged = 0;
  let skipped = 0;
  const seen = new Set();
  for (const row of rows) {
    const file = targetPath(row.storageKey);
    if (!file) {
      skipped += 1;
      console.warn(`storage:seed: skipped release file ${row.id} (invalid storage key)`);
      continue;
    }
    if (seen.has(file)) {
      unchanged += 1;
      continue;
    }
    seen.add(file);
    if (await writeIfChanged(file, placeholderFor(row))) written += 1;
    else unchanged += 1;
  }
  console.info(
    `storage:seed: ${rows.length} release files; ${written} placeholders written, ${unchanged} unchanged, ${skipped} skipped (${path.relative(process.cwd(), root) || "."}).`,
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
