/**
 * Settings of the E2E suite (tests/e2e). Values come from the process environment first, then `.env.local` (the
 * development secrets file the dev server reads). Secret values (passwords, database URL) are kept in memory only and
 * never printed: helpers that fail name the variable, never its value.
 *
 * - E2E_BASE_URL       the app under test (default http://localhost:3000, the shared dev server)
 * - E2E_DATABASE_URL   PostgreSQL of that app (default DATABASE_URL from .env.local); fixtures, checks and clean-up
 * - E2E_KEEP_DATA=1    keep the records the tests created (default: removed after each test, local servers only)
 * - E2E_KEEP_LIMITS=1  do not reset the shared "unknown"-IP rate-limit buckets in global setup
 * - E2E_REDIS_URL      Redis whose `axs:rl:*` unknown-IP keys global setup also resets (default redis://127.0.0.1:6379,
 *                      best effort; only for local servers)
 * - E2E_HMR=1          let the dev server's hot-reload messages reach the pages (default: dropped, see fixtures.ts)
 */
import fs from "node:fs";
import path from "node:path";

/** Project root (this file is tests/e2e/support/env.ts). */
export const ROOT = path.resolve(__dirname, "..", "..", "..");

let cached: Record<string, string> | null = null;

/** KEY=value lines of .env.local (multi-line PEM values are skipped). Empty when the file is missing. */
export function envLocal(): Record<string, string> {
  if (cached) return cached;
  const env: Record<string, string> = {};
  const file = path.join(ROOT, ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
    }
  }
  cached = env;
  return env;
}

/** A setting from the environment or .env.local; undefined when unset or empty. */
export function setting(name: string): string | undefined {
  const value = process.env[name] ?? envLocal()[name];
  return value ? value : undefined;
}

/** A required setting; throws naming the variable (never a value) when it is missing. */
export function requiredSetting(name: string): string {
  const value = setting(name);
  if (!value) throw new Error(`${name} is not set (environment or .env.local).`);
  return value;
}

export const BASE_URL = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000").origin;

/** True for a server on this machine: only then do the tests reset rate limits and delete what they created. */
export const IS_LOCAL = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(BASE_URL).hostname);

export const KEEP_DATA = process.env.E2E_KEEP_DATA === "1";

/** PostgreSQL URL without Prisma's query parameters (e.g. ?schema=). */
export function databaseUrl(): string {
  return (process.env.E2E_DATABASE_URL ?? requiredSetting("DATABASE_URL")).replace(/\?.*$/, "");
}

/** Seed logins (pnpm db:seed). */
export const SEED = {
  demoPassword: () => requiredSetting("SEED_DEMO_PASSWORD"),
  ownerEmail: () => requiredSetting("SEED_OWNER_EMAIL"),
  ownerPassword: () => requiredSetting("SEED_OWNER_PASSWORD"),
};

/**
 * Seeded people the journeys sign in as. The dev seed turns two-step on for its staff, so they confirm each sign-in
 * with an emailed code (two-step is optional per person, never forced by role: decisions.md 2026-10-08).
 */
export const PEOPLE = {
  owner: () => ({ email: SEED.ownerEmail(), password: SEED.ownerPassword(), home: "/admin" }),
  admin: () => ({ email: "vikram@axiomatic.example", password: SEED.demoPassword(), home: "/admin" }),
  support: () => ({ email: "sneha@axiomatic.example", password: SEED.demoPassword(), home: "/admin" }),
  finance: () => ({ email: "karan@axiomatic.example", password: SEED.demoPassword(), home: "/admin" }),
  /** Sharma Medicals' Technical contact (the portal journeys that only read). */
  kavya: () => ({ email: "kavya@sharmamedicals.example", password: SEED.demoPassword(), home: "/account" }),
} as const;

export type Person = ReturnType<(typeof PEOPLE)[keyof typeof PEOPLE]>;
