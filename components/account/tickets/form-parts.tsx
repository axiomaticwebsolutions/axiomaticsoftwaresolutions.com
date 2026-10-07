"use client";

import type * as React from "react";
import { FieldError } from "@/components/ui/field";
import { cn } from "@/lib/utils";

/** Prototype portal form controls: 40px, radius 10, 600 weight (inputs and selects). */
export const TICKET_CONTROL = "h-10 rounded-10 px-3 text-[14px] font-semibold";
export const TICKET_TEXTAREA = "min-h-0 rounded-10 px-3 py-2.5 text-[14.5px] leading-[normal]";

/**
 * A labelled control in the prototype's portal form style (label 13px/700 above, 5px gap) with an inline error
 * linked through aria-describedby. `children` receives the ids to put on the control.
 */
export function TicketField({
  id,
  label,
  error,
  className,
  children,
}: {
  id: string;
  label: React.ReactNode;
  error?: string | null;
  className?: string;
  children: (control: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => React.ReactNode;
}) {
  const errorId = `${id}-error`;
  return (
    <div className={cn("grid content-start gap-[5px]", className)}>
      <label htmlFor={id} className="text-[13px] font-bold text-ink">
        {label}
      </label>
      {children({ id, ...(error ? { "aria-describedby": errorId, "aria-invalid": true as const } : {}) })}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </div>
  );
}
