import type * as React from "react";
import { Icon, type IconName } from "@/components/icons/icon";
import { cn } from "@/lib/utils";

/**
 * A settings card (prototype settings grid): 30px lavender icon tile, H2 14.5px/800 and a 12px description, a body
 * grid of fields (auto-fit, 180px minimum), and a footer with a note and an optional action. Server-safe.
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
  onSubmit,
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
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
  className?: string;
}) {
  const headingId = `${id}-title`;
  const inner = (
    <>
      <div className="flex items-center gap-2.5 border-b border-line-subtle px-4 py-3">
        <span aria-hidden="true" className="grid size-[30px] shrink-0 place-items-center rounded-9 bg-lavender-bg text-lavender-fg">
          <Icon name={icon} size={18} />
        </span>
        <div className="min-w-0">
          <h2 id={headingId} className="m-0 text-[14.5px] font-extrabold">
            {title}
          </h2>
          <p className="m-0 mt-px text-[12px] text-ink-2">{description}</p>
        </div>
      </div>
      {children}
      {note || action ? (
        <div className="flex flex-wrap items-center justify-between gap-2.5 border-t border-line-subtle px-4 py-2.5">
          <span className="min-w-0 text-[12px] font-semibold text-ink-2">{note}</span>
          {action}
        </div>
      ) : null}
    </>
  );
  const classes = cn("min-w-0 rounded-14 border border-line-alt bg-surface leading-[normal]", className);
  return as === "form" ? (
    <form id={id} aria-labelledby={headingId} noValidate onSubmit={onSubmit} className={classes}>
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
