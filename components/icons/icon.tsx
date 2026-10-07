import type * as React from "react";
import { cn } from "@/lib/utils";
import { ICON_PATHS, type IconName } from "@/components/icons/registry";

export type { IconName };

export type IconProps = Omit<React.ComponentProps<"svg">, "children" | "viewBox"> & {
  name: IconName;
  /** Rendered width and height in px. */
  size?: number;
  /** Accessible name. Without it the icon is decorative and hidden from assistive technology. */
  label?: string;
};

/** Material Symbols Rounded icon (opsz 24, wght 400, FILL 0) rendered inline; inherits the text colour. */
export function Icon({ name, size = 20, label, className, ...props }: IconProps) {
  const a11y = label
    ? ({ role: "img", "aria-label": label } as const)
    : ({ "aria-hidden": true, focusable: "false" } as const);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      fill="currentColor"
      data-icon={name}
      className={cn("inline-block shrink-0", className)}
      {...a11y}
      {...props}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
