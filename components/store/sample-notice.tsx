import type * as React from "react";
import { cn } from "@/lib/utils";

export type SampleNoticeProps = {
  /** settings["content.sampleNotice"].text */
  text: string;
  className?: string;
} & React.AriaAttributes;

/**
 * Dark sample-content strip at the top of the sticky storefront header (README > Storefront header): ink background,
 * 13px/600 white, 9px vertical padding. One line is 36px tall (strip + 72px bar = the prototype's 108px offsets).
 * Server-safe.
 */
export function SampleNotice({ text, className, ...aria }: SampleNoticeProps) {
  return (
    <p
      data-slot="sample-notice"
      className={cn("m-0 bg-ink px-4 py-[9px] text-center text-[13px] font-semibold leading-[18px] text-white", className)}
      {...aria}
    >
      {text}
    </p>
  );
}
