/**
 * Development seed (`pnpm db:seed`, run by prisma.config.ts as `tsx prisma/seed.ts`).
 *
 * Writes the SAMPLE catalog, customers, orders, licenses, tickets and settings ported from the prototype
 * (prisma/seed-data: pure, unit-tested plan + write path). Refuses to run when NODE_ENV=production. Idempotent:
 * every row has a deterministic id and is upserted, so a second run leaves the same row counts.
 *
 * Secrets: the env owner (SEED_OWNER_EMAIL / SEED_OWNER_PASSWORD) is the real Owner login; Priya, Vikram, Sneha and
 * Karan share SEED_DEMO_PASSWORD. Passwords are stored only as argon2id hashes and never printed. License keys are
 * stored only as HMAC hash + AES-GCM ciphertext + last 4, sealed with LICENSE_KEY_PEPPER / LICENSE_KEY_ENC_KEY.
 */
import { loadEnvConfig } from "@next/env";
import { hashPassword } from "@/lib/auth/password";
import { createPrismaClient } from "@/lib/db";
import { EnvError, getEnv, getLicenseKeySecrets, isProduction, type Env } from "@/lib/env";
import { PASSWORD_ERROR, isAcceptablePassword } from "@/lib/validation/password";
import { allLicenseGroups, buildSeedPlan, type SeedPlanData } from "./seed-data/plan";
import { SeedError, assertNoEmailConflicts, countRows, writeSeedPlan } from "./seed-data/write";

function refuseInProduction(): void {
  if (isProduction()) {
    throw new SeedError("Refusing to seed: NODE_ENV=production. The seed writes SAMPLE data and demo logins.");
  }
}

type SeedPasswords = { owner: string; demo: string | null };

function readPasswords(env: Env): { ownerEmail: string; passwords: SeedPasswords } {
  const ownerEmail = env.SEED_OWNER_EMAIL;
  const owner = env.SEED_OWNER_PASSWORD;
  if (!ownerEmail || !owner) {
    throw new SeedError("SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD are required (run `pnpm secrets` or set them in .env.local).");
  }
  if (!isAcceptablePassword(owner)) throw new SeedError(`SEED_OWNER_PASSWORD: ${PASSWORD_ERROR}`);
  const demo = env.SEED_DEMO_PASSWORD ?? null;
  if (demo !== null && !isAcceptablePassword(demo)) throw new SeedError(`SEED_DEMO_PASSWORD: ${PASSWORD_ERROR}`);
  return { ownerEmail, passwords: { owner, demo } };
}

/** argon2id hash per user id (each with its own salt). Users without a password source map to null. */
async function hashUserPasswords(plan: SeedPlanData, passwords: SeedPasswords): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>();
  for (const user of plan.users) {
    const plain = user.password === "owner" ? passwords.owner : user.password === "demo" ? passwords.demo : null;
    hashes.set(user.row.id, plain === null ? null : await hashPassword(plain));
  }
  return hashes;
}

function printSummary(plan: SeedPlanData, counts: readonly [string, number][], demoEnabled: boolean, ms: number): void {
  const width = Math.max(...counts.map(([label]) => label.length));
  const lines = [
    `Seeded SAMPLE data in ${(ms / 1000).toFixed(1)} s. Row counts:`,
    ...counts.map(([label, n]) => `  ${label.padEnd(width)}  ${n}`),
    `  counters: ${plan.counters.map((c) => `${c.key}=${c.next}`).join(", ")} (never lowered)`,
    `  sample licenses: ${allLicenseGroups(plan).length}, keys stored sealed (hash + ciphertext + last 4)`,
    "",
    "Logins (passwords are in .env.local: SEED_OWNER_PASSWORD for the owner, SEED_DEMO_PASSWORD for demo users):",
    ...plan.logins
      .filter((l) => l.password === "owner" || demoEnabled)
      .map((l) => `  ${l.email.padEnd(32)} ${l.who}${l.twoStep ? " · two-step: emailed code" : ""}`),
  ];
  if (!demoEnabled) lines.push("  SEED_DEMO_PASSWORD is not set, so the demo users cannot sign in.");
  console.info(lines.join("\n"));
}

async function main(): Promise<void> {
  refuseInProduction();
  // prisma passes its environment to the seed process, but `tsx prisma/seed.ts` run directly must load .env* too.
  loadEnvConfig(process.cwd(), true);
  refuseInProduction();
  const env = getEnv();
  const started = Date.now();
  const { ownerEmail, passwords } = readPasswords(env);
  const plan = buildSeedPlan({ now: new Date(), ownerEmail });
  const passwordHashes = await hashUserPasswords(plan, passwords);

  const db = createPrismaClient(env.DATABASE_URL);
  try {
    await assertNoEmailConflicts(db, plan);
    await writeSeedPlan(db, plan, { passwordHashes, licenseKeys: getLicenseKeySecrets() });
    printSummary(plan, await countRows(db), passwords.demo !== null, Date.now() - started);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Seed and env errors are self-explanatory (and never contain secret values); anything else needs its stack.
  if (error instanceof SeedError || error instanceof EnvError) console.error(`${error.name}: ${error.message}`);
  else console.error(error instanceof Error ? (error.stack ?? error.message) : "Seed failed.");
  process.exitCode = 1;
});
