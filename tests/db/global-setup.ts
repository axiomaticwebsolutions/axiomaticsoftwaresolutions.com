import { execSync } from "node:child_process";
import { loadTestEnv } from "../support/load-env";
import { Client } from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** Creates an isolated schema in TEST_DATABASE_URL, applies migrations, and drops it afterwards. */
export default async function setup(project: TestProject) {
  loadTestEnv();
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new Error("TEST_DATABASE_URL is not set (see .env.example).");

  const schema = `test_${process.pid}_${Date.now().toString(36)}`;
  const url = new URL(base);
  url.searchParams.set("schema", schema);
  const databaseUrl = url.toString();

  try {
    execSync("npx prisma migrate deploy", {
      env: { ...process.env, DATABASE_URL: databaseUrl, PRISMA_HIDE_UPDATE_MESSAGE: "1" },
      stdio: "pipe",
    });
  } catch (err) {
    // execSync errors carry stdout/stderr as Buffers; surface Prisma's own message (it never prints the password).
    const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
    const output = [stderr?.toString("utf8"), stdout?.toString("utf8")].filter(Boolean).join("\n").trim();
    throw new Error(`prisma migrate deploy failed for the test database:\n${output || String(err)}`);
  }
  project.provide("databaseUrl", databaseUrl);

  return async () => {
    const plain = new URL(base);
    plain.searchParams.delete("schema");
    const client = new Client({ connectionString: plain.toString() });
    await client.connect();
    try {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  };
}
