"use client";

import { Toaster as Sonner, type ToasterProps as SonnerProps } from "sonner";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/icons/icon";
import { Spinner } from "@/components/ui/spinner";

export { toast } from "sonner";

/** Auto-dismiss delay from README > Toasts (~3.2s). */
export const TOAST_DURATION_MS = 3200;

export type ToasterProps = Omit<SonnerProps, "position"> & {
  /** bottom-right for the portal and admin, bottom-center for storefront pages. */
  position?: "bottom-right" | "bottom-center";
};

/**
 * Dark toasts (ink, radius 12, toast shadow). Mount once per layout. Toasts are announced through Sonner's
 * live region; never put license keys or other secrets in a toast.
 */
export function Toaster({ position = "bottom-right", toastOptions, className, style, ...props }: ToasterProps) {
  return (
    <Sonner
      position={position}
      // Sonner's stylesheet gives its list a system font stack; toasts use the page font (Manrope) like everything else.
      style={{ fontFamily: "inherit", ...style }}
      duration={TOAST_DURATION_MS}
      offset={18}
      mobileOffset={16}
      gap={10}
      className={cn("toaster", className)}
      icons={{
        success: <Icon name="check_circle" size={18} className="text-success-soft" />,
        error: <Icon name="error" size={18} className="text-pink-line" />,
        warning: <Icon name="warning" size={18} className="text-peach-line" />,
        info: <Icon name="info" size={18} className="text-blue-line" />,
        loading: <Spinner tone="onPrimary" size="sm" />,
        close: <Icon name="close" size={16} />,
      }}
      toastOptions={{
        ...toastOptions,
        unstyled: true,
        classNames: {
          toast:
            // Rings of the actions inside sit on ink: primary-accent (8:1) instead of primary (2.9:1, WCAG 1.4.11).
            "flex items-center gap-2.5 rounded-12 bg-ink px-[15px] py-[11px] text-[13.5px] font-semibold text-white shadow-toast [&_:focus-visible]:outline-primary-accent",
          content: "grid min-w-0 flex-1 gap-0.5",
          title: "leading-snug",
          description: "text-[12.5px] font-medium text-admin-text",
          icon: "flex shrink-0 items-center",
          actionButton:
            "shrink-0 cursor-pointer rounded-8 bg-white px-2.5 py-1.5 text-[12.5px] font-bold text-ink transition-colors hover:bg-lavender-bg",
          cancelButton:
            "shrink-0 cursor-pointer rounded-8 px-2.5 py-1.5 text-[12.5px] font-bold text-white transition-colors hover:bg-ink-soft",
          closeButton: "text-white",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
}
