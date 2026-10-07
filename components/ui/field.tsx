"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import { Label, OptionalTag } from "@/components/ui/label";

/** Props Field wires onto its control. */
export type FieldControlProps = {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
  "aria-required"?: true;
};

export type FieldProps = {
  label: React.ReactNode;
  /** Help text under the control. */
  hint?: React.ReactNode;
  /** Error message; marks the control aria-invalid and links the message with aria-describedby. */
  error?: React.ReactNode;
  /** Shows the "Optional" tag after the label. */
  optional?: boolean;
  /** Sets aria-required on the control (use the native `required` attribute on the control when you can). */
  required?: boolean;
  /** Control id. Generated when omitted; pass one when an error summary links to the field. */
  id?: string;
  /** Element at the end of the label row, e.g. a "Forgot password?" link. */
  labelAction?: React.ReactNode;
  /** sm = admin (12.5px labels), md = storefront and portal forms. */
  size?: "sm" | "md";
  className?: string;
  /**
   * The control. A single element (Input, Textarea, NativeSelect) gets the ids cloned in. Use the function form
   * when the focusable element is nested, e.g. Radix Select: {(control) => <Select><SelectTrigger {...control} />...}.
   */
  children: React.ReactElement<FieldControlProps> | ((control: FieldControlProps) => React.ReactNode);
};

/**
 * Label + control + hint + inline error, with the aria wiring done once.
 * Error text: danger colour, 13.5px/600, preceded by an error icon (README > Validation).
 */
export function Field({
  label,
  hint,
  error,
  optional = false,
  required = false,
  id,
  labelAction,
  size = "md",
  className,
  children,
}: FieldProps) {
  const autoId = React.useId();
  const controlId = id ?? `field-${autoId}`;
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;

  const control: FieldControlProps = {
    id: controlId,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error ? { "aria-invalid": true as const } : {}),
    ...(required ? { "aria-required": true as const } : {}),
  };

  const rendered =
    typeof children === "function"
      ? children(control)
      : React.cloneElement(children, {
          ...control,
          "aria-describedby":
            [children.props["aria-describedby"], describedBy].filter(Boolean).join(" ") || undefined,
        });

  return (
    <div data-slot="field" data-invalid={error ? "" : undefined} className={cn("grid gap-1.5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Label htmlFor={controlId} size={size}>
          {label}
          {optional ? <OptionalTag /> : null}
        </Label>
        {labelAction}
      </div>
      {rendered}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
      {hint ? (
        <p id={hintId} className={cn("text-ink-2", size === "sm" ? "text-[12px]" : "text-[13px]")}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Inline error text. Use directly for controls Field cannot wrap (checkbox rows, radio groups). */
export function FieldError({ className, children, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-error"
      className={cn("flex items-start gap-1.5 text-[13.5px] font-semibold text-danger", className)}
      {...props}
    >
      <Icon name="error" size={17} className="mt-px" />
      <span>{children}</span>
    </p>
  );
}

export type FormError = {
  /** id of the control to focus (the Field `id`). */
  fieldId: string;
  message: string;
};

export type FormErrorSummaryProps = Omit<React.ComponentProps<"div">, "title"> & {
  errors: readonly FormError[];
  /** Defaults to the prototype copy "Please fix the {n} highlighted fields." */
  title?: React.ReactNode;
  /**
   * Move focus to the summary when it appears (after a failed submit). Defaults to true. Only the transition from no
   * errors to some errors moves focus, so live re-validation that changes the count never steals focus from a field.
   */
  focusOnMount?: boolean;
};

function defaultSummaryTitle(count: number): string {
  return count === 1 ? "Please fix the highlighted field." : `Please fix the ${count} highlighted fields.`;
}

/** Error summary shown at the top of a form after a failed submit; each entry links to and focuses its field. */
export function FormErrorSummary({
  errors,
  title,
  focusOnMount = true,
  className,
  ...props
}: FormErrorSummaryProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const focused = React.useRef(false);
  const hasErrors = errors.length > 0;

  React.useEffect(() => {
    if (!hasErrors) {
      focused.current = false;
      return;
    }
    if (focusOnMount && !focused.current) {
      focused.current = true;
      ref.current?.focus();
    }
  }, [focusOnMount, hasErrors]);

  if (errors.length === 0) return null;

  return (
    <div
      ref={ref}
      role="alert"
      tabIndex={-1}
      data-slot="form-error-summary"
      className={cn("flex gap-2.5 rounded-14 bg-pink-bg px-[18px] py-3.5 text-danger", className)}
      {...props}
    >
      <Icon name="error" size={20} className="mt-0.5" />
      <div className="grid gap-1.5">
        <p className="font-bold">{title ?? defaultSummaryTitle(errors.length)}</p>
        <ul className="grid gap-1 text-[14px] font-semibold">
          {errors.map((error) => (
            <li key={error.fieldId}>
              <a
                href={`#${error.fieldId}`}
                className="underline underline-offset-2 hover:text-ink"
                onClick={(event) => {
                  const target = document.getElementById(error.fieldId);
                  if (!target) return;
                  event.preventDefault();
                  target.focus();
                  target.scrollIntoView({ block: "center" });
                }}
              >
                {error.message}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
