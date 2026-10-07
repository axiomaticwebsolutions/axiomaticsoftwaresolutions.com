"use client";

import { Icon } from "@/components/icons/icon";
import { toast, Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { ApiClientError, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";

/** Admin prototype: toasts auto-dismiss after 3.4 s. */
export const ADMIN_TOAST_DURATION_MS = 3400;

/**
 * Admin toasts (prototype): fixed bottom-right 18px, ink, radius 12, 11x15px, 13.5px/600, toast shadow, an 18px
 * check_circle in the light success green (errors: the error icon in light pink). Mounted once by
 * app/admin/layout.tsx; modules call `toast.success()` / `toast.error()` (or adminToast below). Never put license
 * keys, secrets or payment details in a toast.
 */
export function AdminToaster() {
  return (
    <Toaster
      position="bottom-right"
      offset={18}
      mobileOffset={16}
      duration={ADMIN_TOAST_DURATION_MS}
      containerAriaLabel="Status messages"
      icons={{
        success: <Icon name="check_circle" size={18} className="text-success-soft" />,
        error: <Icon name="error" size={18} className="text-pink-line" />,
        warning: <Icon name="warning" size={18} className="text-peach-line" />,
        info: <Icon name="info" size={18} className="text-blue-line" />,
        loading: <Spinner tone="onPrimary" size="sm" />,
        close: <Icon name="close" size={16} />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "flex max-w-[calc(100vw-36px)] items-center gap-2 rounded-12 bg-ink px-[15px] py-[11px] text-[13.5px] font-semibold leading-[normal] text-white shadow-toast [&_:focus-visible]:outline-primary-accent",
          icon: "flex h-5 shrink-0 items-center",
        },
      }}
    />
  );
}

/** The message to show for a failed admin request (the server's message, else a generic one). */
export function errorMessage(error: unknown, fallback: string = UNEXPECTED_ERROR_MESSAGE): string {
  if (error instanceof ApiClientError && error.message) return error.message;
  return fallback;
}

/** Toast helpers with the admin wording: success after a mutation, the server's message after a refusal. */
export const adminToast = {
  success: (message: string) => toast.success(message),
  error: (error: unknown, fallback?: string) => toast.error(errorMessage(error, fallback)),
};
