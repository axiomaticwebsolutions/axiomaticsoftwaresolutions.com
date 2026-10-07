/** Sign-out: revokes the current DB session (the route also clears the cookie and re-issues an anonymous CSRF token). */
import "server-only";
import { revokeSession } from "@/lib/auth/sessions";
import { db } from "@/lib/db";
import { log } from "@/lib/log";

export async function signOut(sessionId: string | null | undefined, now: Date = new Date()): Promise<boolean> {
  if (!sessionId) return false;
  const revoked = await revokeSession(db, sessionId, now);
  if (revoked) log.info("signed_out", { sessionId });
  return revoked;
}
