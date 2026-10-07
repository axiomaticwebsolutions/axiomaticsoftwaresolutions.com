"use client";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";

export type PrintButtonProps = {
  /** Button text ("Print"); passed in so the legal copy module stays out of the client bundle. */
  label: string;
};

/** Opens the browser's print dialog for the current document (hidden in the printout itself). */
export function PrintButton({ label }: PrintButtonProps) {
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={() => window.print()}
      className="gap-1.5 rounded-[11px] px-3.5 py-[10.5px] text-[14px] leading-[normal] print:hidden"
    >
      <Icon name="print" size={18} />
      {label}
    </Button>
  );
}
