import type * as React from "react";
import * as Slot from "radix-ui/slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";

export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-2 whitespace-nowrap",
    "font-bold leading-tight no-underline transition-[background-color,border-color,color,box-shadow] duration-150",
    "disabled:cursor-not-allowed disabled:opacity-55 aria-disabled:cursor-not-allowed aria-disabled:opacity-55",
    "aria-busy:cursor-progress aria-busy:aria-disabled:cursor-progress",
    // Forced colours (Windows contrast themes) drop backgrounds: a system-colour border keeps a button’s shape.
    "forced-colors:border forced-colors:border-[color:ButtonText]",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary-hover",
        secondary: "border border-line-input bg-surface text-ink hover:border-primary",
        ghost: "text-ink hover:bg-lavender-bg hover:text-lavender-fg",
        link: "text-primary-link underline-offset-4 hover:text-primary-link-hover hover:underline",
        destructive: "bg-danger text-white hover:bg-danger/90",
        // Reversible but disruptive actions (suspend, reset devices); peach fg is the darkest warm token.
        warning: "bg-peach-fg text-white hover:bg-peach-fg/90",
        "destructive-outline": "border border-pink-line bg-surface text-danger hover:border-danger-border hover:bg-pink-soft",
        dark: "bg-ink text-white hover:bg-ink-soft",
        subtle: "bg-lavender-bg text-lavender-fg hover:bg-lavender-line",
      },
      size: {
        sm: "rounded-8 px-[13px] py-2 text-[13.5px]",
        md: "rounded-12 px-[18px] py-[11px] text-[15px]",
        lg: "rounded-14 px-6 py-[15px] text-base",
        icon: "size-10 rounded-10 p-0",
        "icon-sm": "size-8 rounded-8 p-0",
      },
    },
    compoundVariants: [
      { variant: "primary", size: "lg", className: "shadow-primary" },
      // Links sit inline with text: no box padding, a small radius for the focus outline.
      { variant: "link", className: "rounded-6 p-0 forced-colors:border-0" },
    ],
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    /** Render the single child element (e.g. a next/link `<Link>`) with button styles. */
    asChild?: boolean;
    /**
     * Shows a spinner and makes the button unavailable without native `disabled` (which would drop keyboard focus to
     * <body>): aria-busy + aria-disabled, and clicks and form submission are swallowed. Client state only.
     */
    loading?: boolean;
    /** Replaces the label while loading (ignored with asChild). */
    loadingText?: React.ReactNode;
  };

const SOLID: ReadonlySet<ButtonVariant> = new Set(["primary", "destructive", "warning", "dark"]);

/** Swallows activation of a loading button, including the click that implicit form submission (Enter) fires. */
function preventActivation(event: React.MouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Button. Follows the native default `type` (submit inside a form), so pass `type="button"` for non-submit buttons
 * in forms. With `asChild`, disabled/loading map to aria-disabled because links cannot be disabled natively.
 */
export function Button({
  className,
  variant,
  size,
  asChild = false,
  loading = false,
  loadingText,
  disabled,
  children,
  onClick,
  ...props
}: ButtonProps) {
  const isDisabled = Boolean(disabled) || loading;
  const spinner = loading ? (
    <Spinner tone={SOLID.has(variant ?? "primary") ? "onPrimary" : "primary"} size="sm" />
  ) : null;

  if (asChild) {
    return (
      <Slot.Root
        data-slot="button"
        className={cn(buttonVariants({ variant, size }), isDisabled && "pointer-events-none", className)}
        aria-busy={loading || undefined}
        aria-disabled={isDisabled || undefined}
        onClick={onClick}
        {...props}
      >
        {spinner}
        <Slot.Slottable>{children}</Slot.Slottable>
      </Slot.Root>
    );
  }

  // Native disabled is kept for the real `disabled` prop only: a focused button that becomes disabled is blurred,
  // so a keyboard or screen-reader user would restart from the top of the page after every async action.
  const busy = loading && !disabled;
  return (
    <button
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      aria-busy={loading || undefined}
      aria-disabled={busy || undefined}
      disabled={Boolean(disabled)}
      onClick={busy ? preventActivation : onClick}
      {...props}
    >
      {spinner}
      {loading && loadingText ? loadingText : children}
    </button>
  );
}
