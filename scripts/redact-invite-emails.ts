/**
 * One-off: removes the invitation links that older versions stored in OutboxEmail (team_invite and staff_invite rows),
 * and marks unsent ones FAILED (the invitation stays open; "Resend" mails a fresh link). Invitation emails are now sent
 * directly and never stored (lib/email/defaults.ts LINK_EMAIL_TEMPLATE_IDS). Idempotent; prints counts only.
 *
 *   pnpm exec tsx scripts/redact-invite-emails.ts --dry-run
 *   pnpm exec tsx scripts/redact-invite-emails.ts
 *
 * Reads DATABASE_URL from the environment or the .env files of the current directory (like prisma.config.ts).
 */
import { loadEnvConfig } from "@next/env";
import { createPrismaClient } from "@/lib/db";
import { countStoredInviteLinks, redactStoredInviteLinks } from "@/lib/email/redact";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--dry-run");
  if (unknown.length > 0) throw new Error(`Unknown argument "${unknown[0]}". Use --dry-run to count only.`);
  const silent = { info: () => {}, error: (...a: unknown[]) => console.error(...a) };
  loadEnvConfig(process.cwd(), process.env.NODE_ENV !== "production", silent, true);
  const url = process.env.DATABASE_URL?.trim();
  if (!url || !/^postgres(ql)?:/.test(url)) throw new Error("DATABASE_URL: is required (a postgresql:// connection URL).");
  const db = createPrismaClient(url);
  try {
    const pending = await countStoredInviteLinks(db);
    if (args.includes("--dry-run")) {
      console.info(`${pending} invitation email row(s) would be redacted.`);
      return;
    }
    const changed = await redactStoredInviteLinks(db);
    console.info(`Redacted ${changed} invitation email row(s).`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Redaction failed.");
  process.exit(1);
});
