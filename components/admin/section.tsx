import type * as React from "react";
import { cn } from "@/lib/utils";

export type SectionTone = "default" | "muted" | "sage" | "peach" | "pink" | "lavender" | "blue";

const TONE_TEXT: Record<SectionTone, string> = {
  default: "text-ink",
  muted: "text-ink-2",
  sage: "text-sage-fg",
  peach: "text-peach-fg",
  pink: "text-pink-fg",
  lavender: "text-lavender-fg",
  blue: "text-blue-fg",
};

export type AdminSectionProps = {
  title: React.ReactNode;
  /** Small element at the end of the title row (a count, a link, an action). */
  action?: React.ReactNode;
  /** Shown instead of the children when they are empty (null, false or []): "No devices activated." */
  empty?: React.ReactNode;
  /** Heading id (aria-labelledby of the section); generated from `id` when given. */
  id?: string;
  className?: string;
  children?: React.ReactNode;
};

/**
 * Drawer section (prototype): a bordered card (radius 12) with an H3 title row and rows or free content
 * (devices, payments, webhook events, history, conversation). Server-safe.
 */
export function AdminSection({ title, action, empty, id, className, children }: AdminSectionProps) {
  const headingId = id ? `${id}-title` : undefined;
  const hasChildren =
    children !== null && children !== undefined && children !== false && !(Array.isArray(children) && children.length === 0);
  return (
    <section aria-labelledby={headingId} className={cn("min-w-0 rounded-12 border border-line-subtle", className)}>
      <div className="flex items-center justify-between gap-3 border-b border-line-subtle px-3 py-2.5">
        <h3 id={headingId} className="m-0 text-[12.5px] font-extrabold leading-[normal]">
          {title}
        </h3>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {!hasChildren && empty !== undefined ? <p className="m-0 p-3 text-[13px] text-ink-2">{empty}</p> : children}
    </section>
  );
}

export type SectionRowProps = {
  /** Bold first line. */
  title: React.ReactNode;
  /** Secondary line (12px/600, ink-2). */
  detail?: React.ReactNode;
  /** Status text on the right (12px/700), coloured by `tone`. */
  status?: React.ReactNode;
  tone?: SectionTone;
  /** A small action (AdminAction size="xs"). */
  action?: React.ReactNode;
  className?: string;
};

/** One row of a drawer section: title + detail on the left, status text and a small action on the right. */
export function SectionRow({ title, detail, status, tone = "muted", action, className }: SectionRowProps) {
  return (
    <li className={cn("flex items-center gap-2.5 border-b border-line-subtle px-3 py-[9px] text-[13px] last:border-b-0", className)}>
      <div className="min-w-0 flex-1">
        <div className="break-words font-bold">{title}</div>
        {detail ? <div className="break-words text-[12px] font-semibold text-ink-2">{detail}</div> : null}
      </div>
      {status ? <span className={cn("whitespace-nowrap text-[12px] font-bold", TONE_TEXT[tone])}>{status}</span> : null}
      {action ?? null}
    </li>
  );
}

/** The list that holds SectionRows (an unstyled <ul>). */
export function SectionRows({ children, className, "aria-label": ariaLabel }: { children: React.ReactNode; className?: string; "aria-label"?: string }) {
  return (
    <ul aria-label={ariaLabel} className={cn("m-0 list-none p-0", className)}>
      {children}
    </ul>
  );
}

/** Padded free content inside a section (forms, notes, a conversation). */
export function SectionBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("grid gap-2.5 p-3", className)}>{children}</div>;
}
