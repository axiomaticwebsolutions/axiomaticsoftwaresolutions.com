import type * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";
import { cn } from "@/lib/utils";

/**
 * A settings card (prototype settings grid): 30px lavender icon tile, H2 14.5px/800 and a 12px description, a body
 * grid of fields (auto-fit, 180px minimum), and a footer with a note and an optional action. Server-safe.
 *
 * Cards in a row of the settings grid share one height (owner request 2026-10-08; precedent
 * components/admin/overview/panel.tsx): the card is a flex column, the body takes the extra height with its own
 * content packed at the top, so the footers (Save / test bar) line up at the bottom of the row.
 */
export function SettingsCard({
  id,
  icon,
  title,
  description,
  note,
  action,
  children,
  as = "section",
  headingLevel = 2,
  onSubmit,
  autoComplete,
  className,
}: {
  id: string;
  icon: IconName;
  title: string;
  description: string;
  note?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  as?: "section" | "form";
  /** 3 inside a titled group (the integration cards under "Integrations"). */
  headingLevel?: 2 | 3;
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
  /** Forms only: "off" for the integration cards (no browser autofill or password manager). */
  autoComplete?: "off";
  className?: string;
}) {
  const headingId = `${id}-title`;
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const inner = (
    <>
      <div className="flex shrink-0 items-center gap-2.5 border-b border-line-subtle px-4 py-3">
        <span aria-hidden="true" className="grid size-[30px] shrink-0 place-items-center rounded-9 bg-lavender-bg text-lavender-fg">
          <Icon name={icon} size={18} />
        </span>
        <div className="min-w-0">
          <Heading id={headingId} className="m-0 text-[14.5px] font-extrabold">
            {title}
          </Heading>
          <p className="m-0 mt-px text-[12px] text-ink-2">{description}</p>
        </div>
      </div>
      {/* The body takes the extra height of the row, but its own content stays packed at the top (content-start). */}
      <div data-slot="settings-card-body" className="min-w-0 flex-1 content-start">
        {children}
      </div>
      {note || action ? (
        <div data-slot="settings-card-footer" className="flex shrink-0 flex-wrap items-center justify-between gap-2.5 border-t border-line-subtle px-4 py-2.5">
          <span className="min-w-0 text-[12px] font-semibold text-ink-2">{note}</span>
          {action}
        </div>
      ) : null}
    </>
  );
  const classes = cn("flex min-w-0 flex-col rounded-14 border border-line-alt bg-surface leading-[normal]", className);
  return as === "form" ? (
    <form id={id} aria-labelledby={headingId} noValidate autoComplete={autoComplete} onSubmit={onSubmit} className={classes}>
      {inner}
    </form>
  ) : (
    <section id={id} aria-labelledby={headingId} className={classes}>
      {inner}
    </section>
  );
}

/** The body grid of a card (prototype: auto-fit columns of at least 180px, 12px gaps). */
export const SETTINGS_GRID_CLASS = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] gap-3 px-4 py-3.5";

export function SettingsGrid({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn(SETTINGS_GRID_CLASS, className)}>{children}</div>;
}
