"use client";

import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";

/** Filterable list (cmdk). Arrow keys move, Enter selects. */
export function Command({ className, ...props }: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn("flex h-full w-full flex-col overflow-hidden bg-surface text-ink", className)}
      {...props}
    />
  );
}

export type CommandDialogProps = React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  className?: string;
  /** Props for the inner Command (e.g. shouldFilter={false} for server-side search). */
  commandProps?: React.ComponentProps<typeof CommandPrimitive>;
};

/** Ctrl/Cmd+K palette shell: a top-aligned dialog wrapping Command. Pair with useCommandShortcut. */
export function CommandDialog({
  title = "Search",
  description = "Type to search, then use the arrow keys and Enter.",
  children,
  className,
  commandProps,
  ...props
}: CommandDialogProps) {
  return (
    <Dialog {...props}>
      <DialogContent
        showClose={false}
        className={cn("top-[12vh] max-w-[640px] translate-y-0 gap-0 overflow-hidden p-0 sm:p-0", className)}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command {...commandProps}>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

/** Toggles the palette on Ctrl+K / Cmd+K anywhere on the page. */
export function useCommandShortcut(onToggle: () => void, key = "k"): void {
  const latest = React.useRef(onToggle);
  React.useEffect(() => {
    latest.current = onToggle;
  });
  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === key && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        latest.current();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [key]);
}

export function CommandInput({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div data-slot="command-input-wrapper" className="flex items-center gap-2.5 border-b border-line px-4">
      <Icon name="search" size={20} className="text-ink-3" />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "h-[52px] w-full min-w-0 bg-transparent text-[15px] text-ink outline-none placeholder:text-ink-3 focus-visible:outline-hidden disabled:opacity-50",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("max-h-[min(400px,60dvh)] scroll-py-1.5 overflow-y-auto overflow-x-hidden p-1.5", className)}
      {...props}
    />
  );
}

export function CommandEmpty({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn("px-3 py-8 text-center text-[14px] text-ink-2", className)}
      {...props}
    />
  );
}

export function CommandGroup({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        "overflow-hidden text-ink [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2.5",
        "[&_[cmdk-group-heading]]:text-[11.5px] [&_[cmdk-group-heading]]:font-extrabold [&_[cmdk-group-heading]]:uppercase",
        "[&_[cmdk-group-heading]]:tracking-[0.08em] [&_[cmdk-group-heading]]:text-ink-2",
        className,
      )}
      {...props}
    />
  );
}

export function CommandItem({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "relative flex cursor-pointer select-none items-center gap-2.5 rounded-8 px-2.5 py-2 text-[14px] font-semibold outline-none",
        "data-[selected=true]:bg-lavender-bg data-[selected=true]:text-lavender-fg data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function CommandSeparator({ className, ...props }: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1.5 my-1 h-px bg-line-subtle", className)}
      {...props}
    />
  );
}

export function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn("ml-auto font-mono text-[11.5px] tracking-wide text-ink-3", className)}
      {...props}
    />
  );
}
