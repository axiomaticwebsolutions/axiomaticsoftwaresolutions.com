import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/brand/logo";
import { Icon } from "@/components/icons/icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatBytes } from "@/lib/branding/model";
import { formatDateTimeIST } from "@/lib/dates";
import { db } from "@/lib/db";
import { DEV_MAILBOX_LIMIT, listDevMail, type DevMail } from "@/lib/email/dev-mailbox";
import { resolveEmail } from "@/lib/integrations/resolver";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dev mailbox",
  robots: { index: false, follow: false },
};

type OutboxCounts = Record<"PENDING" | "SENDING" | "SENT" | "FAILED", number>;

async function outboxCounts(): Promise<OutboxCounts | null> {
  try {
    const rows = await db.outboxEmail.groupBy({ by: ["status"], _count: { _all: true } });
    const counts: OutboxCounts = { PENDING: 0, SENDING: 0, SENT: 0, FAILED: 0 };
    for (const row of rows) counts[row.status] = row._count._all;
    return counts;
  } catch {
    return null;
  }
}

/** The effective email transport (Admin-saved SMTP / Amazon SES or the env fallback; lib/integrations/resolver.ts). */
async function transportName(): Promise<string | null> {
  try {
    const email = await resolveEmail();
    return email.source === "none" ? null : email.config.transport;
  } catch {
    return null;
  }
}

function sentLabel(mail: DevMail): string {
  return formatDateTimeIST(new Date(mail.sentAt));
}

/** Download link of attachment `index` (GET /api/dev/mailbox/:id/attachments/:index, development only). */
function attachmentHref(mail: DevMail, index: number): string {
  return `/api/dev/mailbox/${encodeURIComponent(mail.id)}/attachments/${index}`;
}

function AttachmentList({ mail }: { mail: DevMail }) {
  const files = mail.attachments ?? [];
  if (files.length === 0) return null;
  return (
    <ul className="m-0 grid list-none gap-1.5 p-0">
      {files.map((file, index) => (
        <li key={`${file.filename}-${index}`} className="flex min-w-0 flex-wrap items-center gap-2">
          <Icon name="attach_file" size={18} className="text-muted-icon" />
          <a href={attachmentHref(mail, index)} download={file.filename} className="break-all font-semibold">
            {file.filename}
          </a>
          <span className="text-ink-2">{formatBytes(file.size)}</span>
        </li>
      ))}
    </ul>
  );
}

function MessageList({ messages, selectedId }: { messages: DevMail[]; selectedId: string | undefined }) {
  return (
    <nav aria-label="Messages" className="min-w-0">
      <ul className="grid gap-2">
        {messages.map((mail) => {
          const current = mail.id === selectedId;
          return (
            <li key={mail.id}>
              <Link
                href={`/dev/mailbox?id=${encodeURIComponent(mail.id)}`}
                aria-current={current ? "true" : undefined}
                className={cn(
                  "grid min-w-0 gap-1 rounded-14 border bg-surface px-4 py-3 no-underline hover:border-primary-accent",
                  current ? "border-primary bg-lavender-soft" : "border-line",
                )}
              >
                <span className="truncate text-[14.5px] font-extrabold text-ink">{mail.subject}</span>
                <span className="truncate text-[13px] font-semibold text-ink-2">{mail.to}</span>
                <span className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                  <Badge tone="slate" size="sm">
                    {mail.templateId}
                  </Badge>
                  {sentLabel(mail)}
                  {mail.attachments && mail.attachments.length > 0 ? (
                    <span className="inline-flex items-center gap-0.5">
                      <Icon name="attach_file" size={16} className="text-muted-icon" />
                      <span className="sr-only">Attachments: </span>
                      {mail.attachments.length}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function MessageView({ mail }: { mail: DevMail }) {
  return (
    <section aria-labelledby="message-subject" className="grid min-w-0 content-start gap-4">
      <Card className="gap-3 p-5">
        <h2 id="message-subject" className="break-words text-[19px] font-extrabold leading-snug tracking-[-0.01em]">
          {mail.subject}
        </h2>
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13.5px]">
          <dt className="font-bold text-ink-2">To</dt>
          <dd className="break-all">{mail.to}</dd>
          <dt className="font-bold text-ink-2">Template</dt>
          <dd className="font-mono text-[13px]">{mail.templateId}</dd>
          <dt className="font-bold text-ink-2">Sent</dt>
          <dd>{sentLabel(mail)} IST</dd>
          {mail.attachments && mail.attachments.length > 0 ? (
            <>
              <dt className="font-bold text-ink-2">Attachments</dt>
              <dd className="min-w-0">
                <AttachmentList mail={mail} />
              </dd>
            </>
          ) : null}
        </dl>
      </Card>
      <iframe
        title={`HTML version of “${mail.subject}”`}
        srcDoc={mail.html}
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        className="h-[720px] w-full rounded-16 border border-line bg-surface"
      />
      <details className="rounded-16 border border-line bg-surface">
        <summary className="cursor-pointer rounded-16 px-5 py-3.5 text-[14.5px] font-bold">Plain-text version</summary>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words border-t border-line px-5 py-4 font-mono text-[13px] leading-relaxed text-ink">
          {mail.text}
        </pre>
      </details>
    </section>
  );
}

const COUNT_LABELS: ReadonlyArray<[keyof OutboxCounts, string]> = [
  ["PENDING", "Pending"],
  ["SENDING", "Sending"],
  ["SENT", "Sent"],
  ["FAILED", "Failed"],
];

/** Development-only inbox for the console email transport. A 404 in production (also enforced by app/dev/layout). */
export default async function DevMailboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const params = await searchParams;
  const requested = typeof params.id === "string" ? params.id : undefined;
  const messages = listDevMail();
  const selected = messages.find((m) => m.id === requested) ?? messages[0];
  const [counts, transport] = await Promise.all([outboxCounts(), transportName()]);

  return (
    <main id="main" className="mx-auto grid max-w-admin gap-8 overflow-x-clip px-4 py-10 sm:px-6">
      <header className="grid gap-5">
        <Logo />
        <div className="grid gap-2">
          <p className="text-overline uppercase text-primary-link">Development only</p>
          <h1 className="text-[clamp(30px,4vw,44px)] font-extrabold leading-tight tracking-[-0.035em]">Mailbox</h1>
          <p className="max-w-[760px] text-[16px] text-ink-2">
            The last {DEV_MAILBOX_LIMIT} emails sent through the console transport by this server process, newest
            first. Codes and links appear only here, never in the server log. This route is a 404 in production.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="secondary" size="sm">
            <Link href={selected ? `/dev/mailbox?id=${encodeURIComponent(selected.id)}` : "/dev/mailbox"}>
              <Icon name="restart_alt" size={18} />
              Refresh
            </Link>
          </Button>
          {counts ? (
            <p className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-ink-2">
              <span>Outbox:</span>
              {COUNT_LABELS.map(([status, label]) => (
                <Badge key={status} tone={status === "FAILED" && counts[status] > 0 ? "pink" : "slate"} size="sm">
                  {label} {counts[status]}
                </Badge>
              ))}
            </p>
          ) : null}
        </div>
      </header>

      {transport === "smtp" || transport === "ses" ? (
        <Alert tone="info" role="note">
          <AlertTitle>Emails are going out through {transport === "ses" ? "Amazon SES" : "SMTP"}</AlertTitle>
          <AlertDescription>
            {transport === "ses" ? "An Amazon SES" : "An SMTP"} configuration is active, so new messages are delivered and not kept here.
          </AlertDescription>
        </Alert>
      ) : null}

      {selected ? (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <MessageList messages={messages} selectedId={selected.id} />
          <MessageView mail={selected} />
        </div>
      ) : (
        <Card className="items-center gap-2 px-6 py-12 text-center">
          <Icon name="mark_email_unread" size={32} className="text-muted-icon" />
          <h2 className="text-[18px] font-extrabold">No emails yet</h2>
          <p className="max-w-[520px] text-[15px] text-ink-2">
            Register, request a demo or place an order, then refresh. Messages live in memory, so restarting the dev
            server empties this list.
          </p>
        </Card>
      )}
    </main>
  );
}
