/**
 * Renders the attachments of a claimed outbox row at send time (server-only; docs/decisions.md "Invoice PDF attached
 * to the order email", docs/security.md "Email attachments"). The row holds typed references only
 * (lib/email/attachment-refs.ts); this module turns them into files, after the claim and outside any transaction.
 *
 * "invoice": the order's CURRENT tax invoice through lib/invoice/document.ts orderInvoicePdf(), the helper both
 * invoice.pdf routes use, so the attachment is the document the routes would serve at that moment (after a billing
 * correction, the replacement invoice) under the same file name. It is attached only when the row's recipient is the
 * order's email: the address the order link (a bearer link to the same invoice) is sent to.
 *
 * Failure policy (the email carries the order link to the license key, so the PDF never blocks it):
 * - Left out, email sent without it and `email_attachment_skipped` logged: a reference that is unknown, garbled or
 *   not allowed for the template; an unknown order; a recipient that is not the order's email; no invoice (order not
 *   PAID / PARTIALLY_REFUNDED / REFUNDED); a PDF over ATTACHMENT_MAX_BYTES. Retrying would not change these.
 * - Deferred once: a loader or renderer error, a render over ATTACHMENT_RENDER_TIMEOUT_MS, a render that would start
 *   while an abandoned (timed-out) render is still running in this process (`render_busy`), or one that would start
 *   after the run spent ATTACHMENT_RUN_BUDGET_MS rendering (`run_budget`). These may pass (a database blip, a busy
 *   CPU, a fresh budget in the next run). On the row's first attempt resolveAttachments() throws AttachmentRenderError
 *   and the dispatcher treats it like a failed send (the attempt counts, the row returns to PENDING with the normal
 *   backoff: one minute). From the second attempt on the email goes without the file (`email_attachment_skipped`).
 * - The row's final attempt (`finalAttempt`, OUTBOX_MAX_ATTEMPTS) never renders and always goes without files
 *   (reason `final_attempt`). So neither a relay that refuses the message because of the attachment (552/554) nor a
 *   render that takes the process down (each crash costs an attempt through the lease) can use up the attempts and
 *   leave the customer without the email.
 * So a render problem delays the email by at most one backoff step, and nothing about the PDF can make it fail.
 * Logs carry the outbox id, template, kind, reason and attempt; never addresses, subjects, bodies or PDF bytes.
 *
 * Cost: one invoice render is CPU work of a few hundred milliseconds in the dispatching process. A dispatch run renders
 * at most one PDF per claimed row that carries a reference (the run's limit: 25 for the after-commit kick, 50 per cron
 * batch) and starts no render once its renders took ATTACHMENT_RUN_BUDGET_MS in total (render time only; sends do not
 * count), so attachments add at most that plus one timeout to a run, well inside the outbox lease (OUTBOX_LEASE_MS).
 * A timed-out render cannot be cancelled (react-pdf has no abort); it finishes in the background, its result is
 * dropped, and while it runs (for at most ABANDONED_RENDER_HOLD_MS) no new render starts anywhere in the process, so
 * slow renders cannot pile up on the thread that serves web requests. A render stuck in synchronous work blocks the
 * event loop itself; no timer can interrupt that (only a worker thread could; not used).
 */
import "server-only";
import { db as defaultDb, type Db } from "@/lib/db";
import { log } from "@/lib/log";
import { parseAttachmentRefs, type EmailAttachmentKind, type EmailAttachmentRef } from "./attachment-refs";
import { sendErrorSummary, type OutgoingAttachment } from "./transport";

/** A render slower than this is abandoned (the email is retried once, then sent without the file). */
export const ATTACHMENT_RENDER_TIMEOUT_MS = 15_000;
/** A rendered file over this size is left out (mail servers commonly refuse 10-25 MB messages; base64 adds a third). */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** From this attempt on, a file that fails to render is left out and the email goes without it. */
export const ATTACHMENT_FALLBACK_ATTEMPT = 2;
/** Rendering time one dispatch run may spend on attachments (sends excluded); later renders of the run are deferred. */
export const ATTACHMENT_RUN_BUDGET_MS = 3 * 60_000;
/**
 * How long an abandoned render that is still running keeps new renders from starting in this process. Bounded so a
 * render that never settles cannot switch the attachment off until the next restart.
 */
export const ABANDONED_RENDER_HOLD_MS = 2 * 60_000;

/** Reasons a file is deferred once (the row is retried through the outbox backoff), then left out. */
export type AttachmentDeferReason = "render_failed" | "render_timeout" | "render_busy" | "run_budget";

export type AttachmentSkipReason =
  | "invalid_reference"
  | "order_not_found"
  | "recipient_mismatch"
  | "invoice_unavailable"
  | "too_large"
  | "final_attempt"
  | AttachmentDeferReason;

/** A file that could not be rendered now in a way that may pass: the row is retried once through the outbox backoff. */
export class AttachmentRenderError extends Error {
  readonly code: `attachment_${AttachmentDeferReason}`;
  readonly kind: EmailAttachmentKind;
  readonly reason: AttachmentDeferReason;
  constructor(kind: EmailAttachmentKind, reason: AttachmentDeferReason) {
    super(`The ${kind} attachment could not be rendered; the email is retried once, then sent without it.`);
    this.name = "AttachmentRenderError";
    this.kind = kind;
    this.reason = reason;
    this.code = `attachment_${reason}`;
  }
}

/** The claimed row fields the resolver reads. */
export type AttachmentRow = { id: string; templateId: string; to: string; attempts: number; attachments: unknown };

/** One dispatch run's attachment limits; `spentMs` accumulates across the run's rows (one object per run). */
export type AttachmentRunContext = {
  /** Rendering time this run may spend (ATTACHMENT_RUN_BUDGET_MS). No render starts once `spentMs` reaches it. */
  budgetMs: number;
  /** Rendering time spent so far in this run (each render's duration is added, timeouts included; sends are not). */
  spentMs: number;
  /** The row's last attempt (OUTBOX_MAX_ATTEMPTS): from this attempt on the email goes without files, unrendered. */
  finalAttempt: number;
  /** Per-file render timeout (default ATTACHMENT_RENDER_TIMEOUT_MS; tests). */
  timeoutMs?: number;
  /** Database client (default the shared one). */
  client?: Db;
};

/** A new run's context (dispatchPendingEmails): nothing spent yet, the default budget unless a test shortens it. */
export function attachmentRunContext(finalAttempt: number, opts: { budgetMs?: number; timeoutMs?: number } = {}): AttachmentRunContext {
  return { budgetMs: opts.budgetMs ?? ATTACHMENT_RUN_BUDGET_MS, spentMs: 0, finalAttempt, timeoutMs: opts.timeoutMs };
}

/** A rendered file, or why the reference produced none (a reason retrying would not change). */
type Rendered = OutgoingAttachment | "order_not_found" | "recipient_mismatch" | "invoice_unavailable" | "too_large";

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function renderInvoice(ref: Extract<EmailAttachmentRef, { kind: "invoice" }>, to: string, client: Db): Promise<Rendered> {
  const order = await client.order.findUnique({ where: { id: ref.orderId }, select: { email: true } });
  if (!order) return "order_not_found";
  // Only the order's own email gets its invoice (the person the order link goes to; docs/security.md).
  if (!sameAddress(order.email, to)) return "recipient_mismatch";
  // Loaded on demand: @react-pdf/renderer and the fonts stay out of the routes that merely enqueue email.
  const { orderInvoicePdf } = await import("@/lib/invoice/document");
  const file = await orderInvoicePdf(client, ref.orderId);
  if (!file) return "invoice_unavailable";
  if (file.pdf.length > ATTACHMENT_MAX_BYTES) return "too_large";
  return { filename: file.fileName, contentType: "application/pdf", content: file.pdf };
}

function renderRef(ref: EmailAttachmentRef, to: string, client: Db): Promise<Rendered> {
  switch (ref.kind) {
    case "invoice":
      return renderInvoice(ref, to, client);
  }
}

// ---------- Abandoned renders (process-wide) ----------

/**
 * Timed-out renders still running, each with the time it was abandoned. On globalThis so every route bundle of one
 * server process shares it (like the outbox kick state): the kick, the cron route and any other dispatcher.
 */
type RenderState = { abandoned: Set<{ since: number }> };
const renderHolder = globalThis as unknown as { __axsAttachmentRenders?: RenderState };
function renderState(): RenderState {
  renderHolder.__axsAttachmentRenders ??= { abandoned: new Set() };
  return renderHolder.__axsAttachmentRenders;
}

/** Abandoned renders still running in this process (tests, diagnostics). */
export function abandonedAttachmentRenders(): number {
  return renderState().abandoned.size;
}

/** True while a render abandoned less than ABANDONED_RENDER_HOLD_MS ago is still running in this process. */
function rendererBusy(now: number): boolean {
  for (const entry of renderState().abandoned) if (now - entry.since < ABANDONED_RENDER_HOLD_MS) return true;
  return false;
}

const TIMED_OUT = Symbol("timed_out");

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // A late failure of an abandoned render must not become an unhandled rejection.
  promise.catch(() => undefined);
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    const outcome = await Promise.race([promise, timeout]);
    if (outcome === TIMED_OUT) {
      // It keeps running (no abort): tracked until it settles, so no new render starts meanwhile (render_busy).
      const { abandoned } = renderState();
      const entry = { since: Date.now() };
      abandoned.add(entry);
      const release = () => {
        abandoned.delete(entry);
      };
      void promise.then(release, release);
    }
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

function logSkipped(row: AttachmentRow, kind: string, reason: AttachmentSkipReason, extra: Record<string, unknown> = {}): void {
  log.warn("email_attachment_skipped", { outboxId: row.id, template: row.templateId, kind, reason, attempt: row.attempts, ...extra });
}

type RefOutcome =
  | { file: OutgoingAttachment }
  | { skip: Exclude<Rendered, OutgoingAttachment> }
  | { defer: AttachmentDeferReason; error?: Record<string, string | number> };

/** Renders one reference within the run's budget, the process-wide guard and the timeout; adds its time to the run. */
async function renderWithinLimits(ref: EmailAttachmentRef, row: AttachmentRow, ctx: AttachmentRunContext, client: Db): Promise<RefOutcome> {
  if (ctx.spentMs >= ctx.budgetMs) return { defer: "run_budget" };
  if (rendererBusy(Date.now())) return { defer: "render_busy" };
  const started = Date.now();
  try {
    const outcome = await withTimeout(renderRef(ref, row.to, client), ctx.timeoutMs ?? ATTACHMENT_RENDER_TIMEOUT_MS);
    if (outcome === TIMED_OUT) return { defer: "render_timeout" };
    return typeof outcome === "string" ? { skip: outcome } : { file: outcome };
  } catch (error) {
    return { defer: "render_failed", error: sendErrorSummary(error ?? new Error("render failed")) };
  } finally {
    ctx.spentMs += Date.now() - started;
  }
}

/**
 * The files to send with a claimed row, rendered now (see the module comment for the failure policy). Returns [] for
 * a row without references without touching the database. Throws AttachmentRenderError only to defer the row once.
 */
export async function resolveAttachments(row: AttachmentRow, ctx: AttachmentRunContext): Promise<OutgoingAttachment[]> {
  if (row.attachments === null || row.attachments === undefined) return [];
  const { refs, problems } = parseAttachmentRefs(row.templateId, row.attachments);
  for (const p of problems) logSkipped(row, p.kind ?? "unknown", "invalid_reference", { problem: p.problem });
  if (refs.length === 0) return [];
  if (row.attempts >= ctx.finalAttempt) {
    // The last attempt is always plain: nothing about the file (a relay refusing it, a crashing render) fails the email.
    for (const ref of refs) logSkipped(row, ref.kind, "final_attempt");
    return [];
  }

  const client = ctx.client ?? defaultDb;
  const files: OutgoingAttachment[] = [];
  for (const ref of refs) {
    const outcome = await renderWithinLimits(ref, row, ctx, client);
    if ("file" in outcome) {
      files.push(outcome.file);
      continue;
    }
    if ("skip" in outcome) {
      logSkipped(row, ref.kind, outcome.skip);
      continue;
    }
    // Deferrable: retry the whole email once through the outbox backoff, then send it without the file.
    const details = outcome.error ? { error: outcome.error } : {};
    if (row.attempts < ATTACHMENT_FALLBACK_ATTEMPT) {
      log.warn("email_attachment_retry", { outboxId: row.id, template: row.templateId, kind: ref.kind, reason: outcome.defer, attempt: row.attempts, ...details });
      throw new AttachmentRenderError(ref.kind, outcome.defer);
    }
    logSkipped(row, ref.kind, outcome.defer, details);
  }
  return files;
}
