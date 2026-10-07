import type * as React from "react";
import { cn } from "@/lib/utils";

/** Card shell of the Security page (prototype: white, 1px line-alt border, radius 16). */
export const SECURITY_CARD = "min-w-0 rounded-16 border border-line-alt bg-surface";

/** Card heading row: 14x18px padding, bottom rule, 15px/800 title. */
export function CardHeading({ id, children, action }: { id: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle px-[18px] py-3.5">
      <h2 id={id} className="m-0 text-[15px] font-extrabold">
        {children}
      </h2>
      {action}
    </div>
  );
}

/** Prototype inputs: 40px, radius 10, 12px sides, 600 weight; invalid border in danger. */
export const SECURITY_INPUT =
  "field-focus h-10 w-full min-w-0 rounded-10 border border-line-input bg-surface px-3 text-[14px] font-semibold text-ink aria-invalid:border-danger-border";

/** Primary card button (prototype "Save profile" / "Update password": 9x16px, radius 10, 16px/700). */
export const SECURITY_SUBMIT = "h-auto rounded-10 px-4 py-[9px] text-[16px] leading-[normal]";

/** Small outline buttons (Export data, Sign out): radius 9, 13-13.5px/700. */
export const SECURITY_SMALL_BUTTON = "h-auto rounded-9 px-3 py-1.5 text-[13px] leading-[normal]";

export type SecurityFieldProps = {
  id: string;
  label: string;
  error?: string;
  className?: string;
  /** The control; give it `id`, aria-invalid and aria-describedby={errorId(id)} when there is an error. */
  children: React.ReactNode;
};

export function errorId(id: string): string {
  return `${id}-error`;
}

/** Label (13px/700) above the control and the prototype's inline error (12.5px/600, danger). */
export function SecurityField({ id, label, error, className, children }: SecurityFieldProps) {
  return (
    <div className={cn("grid gap-[5px]", className)}>
      <label htmlFor={id} className="text-[13px] font-bold">
        {label}
      </label>
      {children}
      {error ? (
        <p id={errorId(id)} className="m-0 text-[12.5px] font-semibold text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** aria props for a control with an optional error. */
export function invalidProps(id: string, error: string | undefined): { "aria-invalid"?: true; "aria-describedby"?: string } {
  return error ? { "aria-invalid": true, "aria-describedby": errorId(id) } : {};
}
