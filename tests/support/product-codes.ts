import { randomInt } from "node:crypto";
import { db } from "@/lib/db";

const handedOut = new Set<string>();

/**
 * A 3-letter product code that no product in the test schema uses yet. DB test files share one schema per run and
 * run in separate workers, so a per-file random pick collides with codes other files created earlier.
 */
export async function freshProductCode(): Promise<string> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const code = Array.from({ length: 3 }, () => String.fromCharCode(65 + randomInt(26))).join("");
    if (handedOut.has(code)) continue;
    handedOut.add(code);
    const taken = await db.product.findUnique({ where: { code }, select: { id: true } });
    if (!taken) return code;
  }
  throw new Error("No free 3-letter product code left in the test schema");
}
