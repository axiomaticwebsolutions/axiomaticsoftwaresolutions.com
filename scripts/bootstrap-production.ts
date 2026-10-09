/**
 * Production bootstrap: catalog, content, settings, counters and the first Owner for an EMPTY production database.
 * The dev seed (`pnpm db:seed`) refuses production and writes demo customers and orders; this writes none.
 *
 * On the server, from the release directory (full node_modules, after `prisma generate` and `prisma migrate deploy`,
 * and before `next build`, which prerenders the storefront from this catalog):
 *
 *   NODE_ENV=production pnpm exec tsx scripts/bootstrap-production.ts --dry-run
 *   NODE_ENV=production pnpm exec tsx scripts/bootstrap-production.ts
 *
 * (`node --import tsx scripts/bootstrap-production.ts` is the same.) Safe on every deploy: once the Owner exists it
 * only adds settings sections, counters and catalog additions (e.g. the 2026-10-09 coming-soon products, each added
 * exactly once) that a newer version introduced, else it prints "nothing to do".
 * What it writes and the idempotency rules: prisma/seed-data/bootstrap.ts and prisma/seed-data/additions.ts.
 *
 * `--additions-only` runs just the catalog additions (no Owner, settings or counters, no BOOTSTRAP_* variables, and no
 * refusal of a database with development seed data), e.g. on a development database:
 *   NODE_ENV=development pnpm exec tsx scripts/bootstrap-production.ts --additions-only [--dry-run]
 * `--skip-additions` is the opposite: everything except the catalog additions. deploy/deploy.sh uses it before the build
 * while an older release is still live (that release's Prisma client cannot read a COMING_SOON product and would fail
 * on admin pages that list every product), then runs `--additions-only` once the new release is live and healthy.
 *
 * Env files: like prisma.config.ts it loads .env files from the current directory with @next/env, except that an
 * unset NODE_ENV reads the production set (.env.production.local, .env.local, .env.production, .env), because this
 * script exists for production only. Values already in the process environment always win over the files.
 *
 * Variables: DATABASE_URL (required); BOOTSTRAP_OWNER_EMAIL / BOOTSTRAP_OWNER_PASSWORD / BOOTSTRAP_OWNER_NAME
 * (required while no Owner exists; export the password in the shell for that one run instead of writing it to a
 * file); BOOTSTRAP_BUSINESS_*, BOOTSTRAP_{SUPPORT,SALES,LEGAL,PRIVACY}_EMAIL, BOOTSTRAP_BUSINESS_SAMPLE and
 * BOOTSTRAP_SAMPLE_NOTICE_TEXT (optional, used when those settings are first created); PAYMENT_PROVIDER and
 * PAYMENT_KEY_ID (pick the sample notice wording); APP_URL (optional, completes the printed sign-in link).
 * The password is never printed, logged or stored in plain text. Exit status 0 = done or nothing to do, 1 = refused
 * or failed (nothing written: the run is one transaction).
 */
import { loadEnvConfig } from "@next/env";
import { createPrismaClient } from "@/lib/db";
import { formatAdditionLines, pendingAdditions, runCatalogAdditions } from "@/prisma/seed-data/additions";
import {
  BootstrapError,
  OWNER_ENV,
  buildBootstrapRows,
  formatBootstrapReport,
  ownerPasswordSource,
  readBootstrapConfig,
  runBootstrap,
  type BootstrapConfig,
  type EnvFile,
} from "@/prisma/seed-data/bootstrap";

const USAGE = [
  "Usage: pnpm exec tsx scripts/bootstrap-production.ts [--dry-run] [--update-catalog] [--additions-only | --skip-additions]",
  "       (run it from the release directory; NODE_ENV=production or unset reads .env.production)",
  "",
  "  --dry-run         Print what would change (counts only) and write nothing (READ ONLY transaction).",
  "  --update-catalog  Overwrite catalog and content with the values in code (category, product and plan copy, plan",
  "                    prices and limits, FAQ answers, email templates) and add rows that are missing, e.g. after a",
  "                    code update. Admin edits to those fields are lost. Kept: product status, archived plans, FAQ",
  "                    visibility and order, template on/off, every release, settings, counters, users, customers,",
  "                    orders and licenses. Run it with --dry-run first.",
  "  --additions-only  Run only the catalog additions (new categories and products, each set added once and never",
  "                    again): no Owner, settings or counters, no BOOTSTRAP_* variables. Works on a development",
  "                    database too. Every normal run applies them as well.",
  "  --skip-additions  Everything except the catalog additions (deploy.sh runs them after the switch with",
  "                    --additions-only, so the release that is still live never reads rows it does not know).",
  "  --help            Show this text.",
  "",
  "First run: export BOOTSTRAP_OWNER_EMAIL and BOOTSTRAP_OWNER_PASSWORD (optionally BOOTSTRAP_OWNER_NAME) in the shell.",
  "Later runs need none of them. The bootstrap never creates a second Owner and never resets a password.",
].join("\n");

type Args = { dryRun: boolean; updateCatalog: boolean; additionsOnly: boolean; skipAdditions: boolean; help: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { dryRun: false, updateCatalog: false, additionsOnly: false, skipAdditions: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--update-catalog") args.updateCatalog = true;
    else if (arg === "--additions-only") args.additionsOnly = true;
    else if (arg === "--skip-additions") args.skipAdditions = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new BootstrapError([`Unknown argument "${arg}". Run with --help for the options.`]);
  }
  if (args.additionsOnly && args.updateCatalog) throw new BootstrapError(["--additions-only and --update-catalog cannot be combined."]);
  if (args.additionsOnly && args.skipAdditions) throw new BootstrapError(["--additions-only and --skip-additions cannot be combined."]);
  return args;
}

/** --additions-only: the catalog additions alone, in their own locked transaction (READ ONLY with --dry-run). */
async function runAdditionsOnly(url: string, dryRun: boolean): Promise<void> {
  const db = createPrismaClient(url);
  try {
    const plans = await runCatalogAdditions(db, { dryRun });
    const pending = pendingAdditions(plans).length > 0;
    const head = dryRun
      ? "Catalog additions - DRY RUN: nothing was written. Planned changes:"
      : pending
        ? "Catalog additions - done. Changes:"
        : "Catalog additions - nothing to do: every addition was already applied.";
    console.info([head, ...formatAdditionLines(plans, !dryRun)].join("\n"));
  } finally {
    await db.$disconnect();
  }
}

type EnvLoad = { mode: "production" | "development" | "test"; files: EnvFile[]; passwordInProcessEnv: boolean };

/**
 * Loads the .env files described in the header. `forceReload` because a parent Next.js process may have left
 * __NEXT_PROCESSED_ENV set, which would make @next/env skip the files. File contents stay in memory only.
 */
function loadEnvFiles(dir: string): EnvLoad {
  const passwordInProcessEnv = process.env[OWNER_ENV.password] !== undefined;
  const nodeEnv = process.env.NODE_ENV;
  const mode = nodeEnv === "test" ? "test" : nodeEnv === "development" ? "development" : "production";
  const silent = { info: () => {}, error: (...a: unknown[]) => console.error(...a) };
  const { loadedEnvFiles } = loadEnvConfig(dir, mode === "development", silent, true);
  return { mode, files: loadedEnvFiles.map((f) => ({ path: f.path, contents: f.contents })), passwordInProcessEnv };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.info(USAGE);
    return;
  }
  const env = loadEnvFiles(process.cwd());
  console.info(`Environment: ${env.mode}; .env files read: ${env.files.map((f) => f.path).join(", ") || "none"}.`);
  if (args.additionsOnly) {
    const additionsUrl = process.env.DATABASE_URL?.trim();
    if (!additionsUrl || !/^postgres(ql)?:/.test(additionsUrl)) throw new BootstrapError(["DATABASE_URL: is required (a postgresql:// connection URL)."]);
    await runAdditionsOnly(additionsUrl, args.dryRun);
    return;
  }
  const notes: string[] = [];
  if (env.mode === "production" && env.files.some((f) => f.path === ".env.local")) {
    notes.push(".env.local was read too, and its values override .env.production. On a server, keep every value in .env.production.");
  }

  // Every problem at once (names and rules only, never values).
  const problems: string[] = [];
  const password = ownerPasswordSource(env.files, env.passwordInProcessEnv, process.env[OWNER_ENV.password]);
  if (password.problem) problems.push(password.problem);
  const url = process.env.DATABASE_URL?.trim();
  if (!url || !/^postgres(ql)?:/.test(url)) problems.push("DATABASE_URL: is required (a postgresql:// connection URL).");
  let config: BootstrapConfig | null = null;
  try {
    config = readBootstrapConfig(process.env);
  } catch (error) {
    if (!(error instanceof BootstrapError)) throw error;
    problems.push(...error.problems);
  }
  if (problems.length > 0 || !config || !url) throw new BootstrapError(problems);

  if (password.file && config.owner) {
    notes.push(
      args.dryRun
        ? `${OWNER_ENV.password} is read from ${password.file}. After the real run, delete that line: the Owner signs in with the stored hash.`
        : `${OWNER_ENV.password} was read from ${password.file}. Delete that line now: the Owner signs in with the stored hash.`,
    );
  }

  const rows = buildBootstrapRows(config);
  if (args.skipAdditions) {
    rows.additions = [];
    notes.push("Catalog additions were not checked (--skip-additions): run --additions-only once the new release is live.");
  }
  const db = createPrismaClient(url);
  try {
    const report = await runBootstrap(db, {
      rows,
      owner: config.owner,
      businessSupplied: config.businessSupplied,
      dryRun: args.dryRun,
      updateCatalog: args.updateCatalog,
    });
    const appUrl = process.env.APP_URL?.trim().replace(/\/+$/, "");
    console.info(formatBootstrapReport(report, { warnings: config.warnings, notes, ...(appUrl ? { appUrl } : {}) }));
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  // BootstrapError messages name variables and rules only; anything else needs its stack (Prisma and pg errors never
  // include the connection password).
  if (error instanceof BootstrapError) console.error(`${error.name}: ${error.message}`);
  else console.error(error instanceof Error ? (error.stack ?? error.message) : "Bootstrap failed.");
  process.exitCode = 1;
});
