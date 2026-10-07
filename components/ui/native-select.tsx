import type * as React from "react";
import { type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import { controlVariants } from "@/components/ui/input";

export type NativeSelectProps = Omit<React.ComponentProps<"select">, "size"> &
  Pick<VariantProps<typeof controlVariants>, "size"> & {
    /** Adds a first empty option, e.g. "Select state". It is disabled so it cannot be re-picked. */
    placeholder?: string;
    wrapperClassName?: string;
  };

/**
 * Styled native <select>. Prefer it for long lists (states, countries) and on mobile, where the OS picker is
 * faster and more accessible than a custom listbox. Server-safe.
 */
export function NativeSelect({
  className,
  wrapperClassName,
  size,
  placeholder,
  children,
  defaultValue,
  value,
  ...props
}: NativeSelectProps) {
  const initial = value === undefined && defaultValue === undefined && placeholder ? "" : defaultValue;
  return (
    <span data-slot="native-select" className={cn("relative block w-full", wrapperClassName)}>
      <select
        className={cn(
          controlVariants({ size }),
          "cursor-pointer appearance-none pr-10 has-[option[value='']:checked]:text-ink-3 [&>option]:text-ink",
          className,
        )}
        value={value}
        defaultValue={initial}
        {...props}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {children}
      </select>
      <Icon
        name="expand_more"
        size={20}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3"
      />
    </span>
  );
}
