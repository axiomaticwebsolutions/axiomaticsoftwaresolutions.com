import type * as React from "react";
import { palette } from "@/lib/design/tokens";
import { cn } from "@/lib/utils";

const BRAND_NAME = "Axiomatic Software Solutions";

/** Peach crossbar of the logo mark (README > Brand assets), from the brand token group. */
const MARK_ACCENT = palette.brand["mark-accent"];

export type LogoMarkProps = Omit<React.ComponentProps<"svg">, "children" | "viewBox"> & {
  /** Rendered size in px (34 in headers and footers, 32/36 elsewhere). */
  size?: number;
};

/** The square "A" mark (32x32 viewBox). Decorative on its own; Logo supplies the accessible name. */
export function LogoMark({ size = 34, className, ...props }: LogoMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      className={cn("shrink-0", className)}
      {...props}
    >
      <rect width="32" height="32" rx="9" className="fill-primary" />
      <path
        d="M8.6 23.6 16 8.4l7.4 15.2"
        fill="none"
        className="stroke-white"
        strokeWidth="3.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M13.6 18.4h10" stroke={MARK_ACCENT} strokeWidth="3.1" strokeLinecap="round" />
    </svg>
  );
}

export type LogoProps = Omit<React.ComponentProps<"span">, "children" | "role"> & {
  /** full = mark + wordmark (headers, footers); compact = mark only (checkout header, collapsed sidebars). */
  variant?: "full" | "compact";
  /** Light wordmark for dark surfaces such as the admin sidebar. */
  onDark?: boolean;
  markSize?: number;
};

/**
 * Brand lockup: mark + "Axiomatic" (18.5px/800/-0.025em) + "SOFTWARE SOLUTIONS" (9px/700/0.17em).
 * Exposed as one image named "Axiomatic Software Solutions", so a wrapping link reads naturally. Server-safe.
 */
export function Logo({ variant = "full", onDark = false, markSize = 34, className, ...props }: LogoProps) {
  return (
    <span
      role="img"
      aria-label={BRAND_NAME}
      data-slot="logo"
      className={cn("inline-flex shrink-0 items-center gap-2.5", className)}
      {...props}
    >
      <LogoMark size={markSize} />
      {variant === "full" ? (
        <span aria-hidden="true" className="flex flex-col whitespace-nowrap leading-none">
          <span className={cn("text-[18.5px] font-extrabold tracking-[-0.025em]", onDark ? "text-white" : "text-ink")}>
            Axiomatic
          </span>
          <span
            className={cn(
              "mt-[3px] text-[9px] font-bold uppercase tracking-[0.17em]",
              onDark ? "text-admin-text" : "text-ink-2",
            )}
          >
            Software Solutions
          </span>
        </span>
      ) : null}
    </span>
  );
}
