"use client";

import { Icon } from "@/components/icons/icon";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";

/**
 * Portal toasts (prototype): fixed bottom-right 20px, ink, radius 12, 12x16px, 14px/600, toast shadow, a 19px
 * check_circle in the light success green, ~3.2 s. Mounted once by app/account/layout.tsx; views call `toast()` /
 * `toast.success()` from components/ui/sonner. Never put license keys or other secrets in a toast.
 */
export function PortalToaster() {
  return (
    <Toaster
      position="bottom-right"
      offset={20}
      mobileOffset={16}
      containerAriaLabel="Status messages"
      icons={{
        success: <Icon name="check_circle" size={19} className="text-success-soft" />,
        error: <Icon name="error" size={19} className="text-pink-line" />,
        warning: <Icon name="warning" size={19} className="text-peach-line" />,
        info: <Icon name="info" size={19} className="text-blue-line" />,
        loading: <Spinner tone="onPrimary" size="sm" />,
        close: <Icon name="close" size={16} />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "flex max-w-[calc(100vw-40px)] items-center gap-2.5 rounded-12 bg-ink px-4 py-3 text-[14px] font-semibold leading-[normal] text-white shadow-toast [&_:focus-visible]:outline-primary-accent",
          icon: "flex h-5 shrink-0 items-center",
        },
      }}
    />
  );
}
