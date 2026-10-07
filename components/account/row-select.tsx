"use client";

import * as React from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { isClosedTypeaheadKey } from "./row-select-keys";

export type RowSelectOption = { value: string; label: string };

/** The prototype's 34px row select ("Location for …", "Role for …"): radius 8, #DDE2EA border, 13px. */
export const ROW_SELECT_TRIGGER =
  "h-[34px] w-auto max-w-full gap-1 rounded-8 border-line-strong py-0 pl-2 pr-1.5 text-[13px] leading-[normal] hover:border-line-input aria-busy:cursor-progress";

/**
 * A listbox select for table rows that act on change (move a device, change a member's role). A closed native
 * <select> in Chrome on Windows fires `change` on every arrow key, so such a select saved (or opened a confirmation
 * for) each option a keyboard user passed (WCAG 3.2.2). Here Arrow keys, Enter and Space open the list, nothing is
 * chosen until Enter or a click, and typeahead on the closed trigger is off. `onValueChange` runs once the list has
 * closed and focus is back on the trigger, so a dialog it opens returns focus there. The trigger is as wide as the
 * longest option, like a native select.
 */
export function RowSelect({
  label,
  value,
  options,
  onValueChange,
  disabled = false,
  busy = false,
  className,
}: {
  /** Accessible name, e.g. "Location for Billing counter PC". */
  label: string;
  value: string;
  options: readonly RowSelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  /** A save is running: aria-busy on the trigger (choices made meanwhile are up to the caller). */
  busy?: boolean;
  className?: string;
}) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const chosen = React.useRef<string | null>(null);
  const onValueChangeRef = React.useRef(onValueChange);
  React.useEffect(() => {
    onValueChangeRef.current = onValueChange;
  });

  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        chosen.current = next === value ? null : next;
      }}
    >
      <SelectTrigger
        ref={triggerRef}
        aria-label={label}
        aria-busy={busy || undefined}
        className={cn(ROW_SELECT_TRIGGER, className)}
        onKeyDown={(event) => {
          if (isClosedTypeaheadKey(event)) event.preventDefault();
        }}
      >
        <span className="grid min-w-0 text-left">
          <span className="col-start-1 row-start-1 min-w-0 truncate">
            <SelectValue />
          </span>
          {/* Sizes the trigger to the longest option (hidden from everyone). */}
          {options.map((option) => (
            <span key={option.value} aria-hidden="true" className="invisible col-start-1 row-start-1 h-0 whitespace-nowrap">
              {option.label}
            </span>
          ))}
        </span>
      </SelectTrigger>
      <SelectContent
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          triggerRef.current?.focus({ preventScroll: true });
          const next = chosen.current;
          chosen.current = null;
          if (next !== null) onValueChangeRef.current(next);
        }}
      >
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} className="py-1.5 text-[13.5px]">
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
