import { loadTestEnv } from "../support/load-env";
import { afterAll, inject } from "vitest";
import { db } from "@/lib/db";

loadTestEnv();
// Point the lazily-created Prisma singleton at this run's isolated schema.
process.env.DATABASE_URL = inject("databaseUrl");

afterAll(async () => {
  await db.$disconnect();
});
