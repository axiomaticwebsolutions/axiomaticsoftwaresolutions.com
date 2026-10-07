/**
 * The dev server's /dev/mailbox (EMAIL_TRANSPORT=console keeps the last 50 messages in memory): codes and links the
 * journeys need. Same parsing as scripts/check-*.mjs. Codes and links are returned to the caller, never printed.
 */
import { BASE_URL } from "./env";

export type Mail = { id: string; subject: string; to: string };

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

/** Messages in the dev mailbox, newest first. */
export async function mailbox(): Promise<Mail[]> {
  const res = await fetch(`${BASE_URL}/dev/mailbox`, { cache: "no-store" });
  if (!res.ok) throw new Error(`/dev/mailbox answered ${res.status}: run the dev server with EMAIL_TRANSPORT=console`);
  const html = await res.text();
  const re = /href="\/dev\/mailbox\?id=([^"]+)"[^>]*>\s*<span[^>]*>([^<]*)<\/span>\s*<span[^>]*>([^<]*)<\/span>/g;
  return [...html.matchAll(re)].map((m) => ({ id: decode(m[1] ?? ""), subject: decode(m[2] ?? ""), to: decode(m[3] ?? "") }));
}

/** Ids of the messages already in the mailbox (pass as `exclude` to wait for a newer one). */
export async function mailIds(): Promise<Set<string>> {
  return new Set((await mailbox()).map((m) => m.id));
}

export async function waitForMail(
  to: string,
  subject: RegExp,
  { exclude = new Set<string>(), timeoutMs = 45_000 }: { exclude?: Set<string>; timeoutMs?: number } = {},
): Promise<Mail> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const hit = (await mailbox()).find((m) => m.to === to && subject.test(m.subject) && !exclude.has(m.id));
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`no email to ${to} matching ${subject} reached /dev/mailbox`);
}

/** The 6-digit code in a code email's subject. */
export function codeFrom(mail: Mail): string {
  const m = /(\d{6})/.exec(mail.subject);
  if (!m?.[1]) throw new Error(`the email "${mail.subject.replace(/\d/g, "#")}" has no 6-digit code`);
  return m[1];
}

/** Waits for a code email (verification or two-step sign-in) newer than `exclude` and returns its code. */
export async function waitForCode(to: string, subject: RegExp, exclude: Set<string>): Promise<string> {
  return codeFrom(await waitForMail(to, subject, { exclude }));
}
