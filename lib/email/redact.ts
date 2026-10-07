/**
 * Clean-up for invitation emails stored before they were sent directly (team_invite since Phase 5, staff_invite since
 * Phase 6): their OutboxEmail rows hold the rendered invitation link, a bearer credential for team or console access
 * while the invitation is open. The link's token is replaced with "removed" in the stored html and text, and rows that
 * had not gone out yet (PENDING, SENDING) are marked FAILED so the dispatcher never sends a dead link; the invitation
 * itself stays open and "Resend" mails a fresh link directly. Idempotent. Run once per database with
 * scripts/redact-invite-emails.ts. No server-only import, so the script can load it.
 */
import type { Db } from "@/lib/db";
import { LINK_EMAIL_TEMPLATE_IDS } from "./defaults";

export const REDACTED_INVITE_ERROR = "Invitation links are no longer stored. Resend the invitation.";

/** Outbox rows of invitation templates that still hold a link or could still be sent. */
export async function countStoredInviteLinks(client: Db): Promise<number> {
  const ids = [...LINK_EMAIL_TEMPLATE_IDS];
  const rows = await client.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS "n" FROM "OutboxEmail"
    WHERE "templateId" = ANY(${ids}::text[])
      AND ("html" ~ 'token=(?!removed)' OR "text" ~ 'token=(?!removed)' OR "status" IN ('PENDING', 'SENDING'))`;
  return Number(rows[0]?.n ?? 0);
}

/** Redacts the stored invitation links (see the module comment). Returns the number of rows changed. */
export async function redactStoredInviteLinks(client: Db): Promise<number> {
  const ids = [...LINK_EMAIL_TEMPLATE_IDS];
  return client.$executeRaw`
    UPDATE "OutboxEmail"
    SET "html" = regexp_replace("html", 'token=[^"&<[:space:]]+', 'token=removed', 'g'),
        "text" = regexp_replace("text", 'token=[^"&<[:space:]]+', 'token=removed', 'g'),
        "lastError" = CASE WHEN "status" IN ('PENDING', 'SENDING') THEN ${REDACTED_INVITE_ERROR} ELSE "lastError" END,
        "status" = CASE WHEN "status" IN ('PENDING', 'SENDING') THEN 'FAILED'::"EmailStatus" ELSE "status" END
    WHERE "templateId" = ANY(${ids}::text[])
      AND ("html" ~ 'token=(?!removed)' OR "text" ~ 'token=(?!removed)' OR "status" IN ('PENDING', 'SENDING'))`;
}
