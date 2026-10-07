/**
 * Work that should not hold up the admin response (the release "update available" fan-out). Inside a Next.js
 * request it runs after the response through next/server after(); elsewhere (scripts, tests) it runs inline. Errors
 * are logged, never thrown: the change it follows is already committed. Server-only.
 */
import "server-only";
import { after } from "next/server";
import { log } from "@/lib/log";

export async function runAfterResponse(event: string, task: () => Promise<unknown>): Promise<void> {
  const safe = async () => {
    try {
      await task();
    } catch (error) {
      log.error(event, { error });
    }
  };
  try {
    after(safe);
  } catch {
    // Outside a request scope (after() throws): run it now.
    await safe();
  }
}
