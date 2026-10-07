/**
 * Dev-only PostgreSQL 17 for machines without a usable local Postgres login.
 *   node scripts/dev-db.mjs        (keeps running; Ctrl+C stops the server)
 * Listens on 127.0.0.1:${DEV_PG_PORT:-5433}, data in ${DEV_PG_DIR:-.pgdata} (git-ignored), and makes sure the role
 * `axiomatic` (password `axiomatic`, CREATEDB) and the databases `axiomatic` + `axiomatic_test` exist, matching
 * .env.example apart from the port. Never use this in production.
 */
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

if (process.env.NODE_ENV === "production") {
  console.error("dev-db is for development only.");
  process.exit(1);
}

const dir = resolve(process.env.DEV_PG_DIR ?? ".pgdata");
const port = Number(process.env.DEV_PG_PORT ?? 5433);
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: "postgres",
  password: process.env.DEV_PG_SUPERUSER_PASSWORD ?? "postgres",
  port,
  persistent: true,
  // UTF-8 like production; the Windows default (WIN1252) cannot store the rupee sign or arrows.
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: () => {},
  onError: (err) => console.error(String(err)),
});

if (!existsSync(join(dir, "PG_VERSION"))) {
  console.info(`Initialising a new dev cluster in ${dir} ...`);
  await pg.initialise();
}
await pg.start();

const client = pg.getPgClient();
await client.connect();
try {
  const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'axiomatic'");
  if (role.rowCount === 0) await client.query("CREATE ROLE axiomatic LOGIN CREATEDB PASSWORD 'axiomatic'");
  for (const name of ["axiomatic", "axiomatic_test"]) {
    const found = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (found.rowCount === 0) await client.query(`CREATE DATABASE "${name}" OWNER axiomatic`);
  }
} finally {
  await client.end();
}

console.info(`Dev Postgres ready on 127.0.0.1:${port} (role axiomatic, databases axiomatic and axiomatic_test).`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
