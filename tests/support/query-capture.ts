/**
 * Query capture and plan checks for DB tests: a Prisma client on the test database that records every SQL statement
 * it sends (with parameters), and helpers to EXPLAIN those statements. Used to prove that portal queries stay on
 * indexes as tables grow (docs/scaling.md "Database indexes").
 */
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { parseDatabaseUrl } from "@/lib/db";

export type CapturedQuery = { sql: string; params: unknown[] };

export function capturingClient(url = process.env.DATABASE_URL): { client: PrismaClient; queries: CapturedQuery[] } {
  if (!url) throw new Error("DATABASE_URL is not set");
  const { connectionString, options, schema } = parseDatabaseUrl(url);
  const adapter = new PrismaPg({ connectionString, ...(options ? { options } : {}), max: 2 }, schema ? { schema } : undefined);
  const client = new PrismaClient({ adapter, log: [{ emit: "event", level: "query" }] });
  const queries: CapturedQuery[] = [];
  client.$on("query", (event) => {
    let params: unknown[] = [];
    try {
      const parsed = JSON.parse(event.params) as unknown;
      if (Array.isArray(parsed)) params = parsed;
    } catch {
      params = [];
    }
    queries.push({ sql: event.query, params });
  });
  return { client: client as unknown as PrismaClient, queries };
}

export type PlanNode = {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Index Cond"?: string;
  "Recheck Cond"?: string;
  Plans?: PlanNode[];
};

/** EXPLAIN (FORMAT JSON) of a captured statement, run on `db` with the captured parameters. */
export async function explain(db: PrismaClient, query: CapturedQuery): Promise<PlanNode> {
  const rows = await db.$queryRawUnsafe<Array<{ "QUERY PLAN": Array<{ Plan: PlanNode }> }>>(`EXPLAIN (FORMAT JSON) ${query.sql}`, ...query.params);
  const plan = rows[0]?.["QUERY PLAN"][0]?.Plan;
  if (!plan) throw new Error("EXPLAIN returned no plan");
  return plan;
}

/** Every node of a plan tree, depth first. */
export function planNodes(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}

/**
 * Scans of `relation` that read the whole table or a whole index: a Seq Scan, or an index scan without an index
 * condition. Empty when every access is bounded by an index condition (e.g. licenseId = ... or IN (...)).
 */
export function unboundedScans(plan: PlanNode, relation: string): PlanNode[] {
  return planNodes(plan).filter((n) => {
    if (n["Relation Name"] !== relation) return false;
    if (n["Node Type"] === "Seq Scan") return true;
    if (n["Node Type"] === "Index Scan" || n["Node Type"] === "Index Only Scan") return !n["Index Cond"];
    if (n["Node Type"] === "Bitmap Heap Scan") return !n["Recheck Cond"];
    return false;
  });
}
