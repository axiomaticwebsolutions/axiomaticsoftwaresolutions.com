import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TicketPriorityKey, TicketStatusKey } from "@/lib/validation/tickets";
import { PRIORITY_STYLES, ticketStatusTone } from "@/components/account/tickets/model";

/** Prototype priority: 7px dot + label in the priority colour (13.5px/700). Server-safe. */
export function TicketPriority({ priority, label, className }: { priority: TicketPriorityKey; label: string; className?: string }) {
  const style = PRIORITY_STYLES[priority];
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap font-bold", style.text, className)}>
      <span aria-hidden="true" className={cn("size-[7px] shrink-0 rounded-pill", style.dot)} />
      {label}
    </span>
  );
}

/** Prototype status pill (3x9px, 12px/800): Waiting for support blue, Waiting for you peach, Resolved sage. */
export function TicketStatusBadge({ status, label, className }: { status: TicketStatusKey; label: string; className?: string }) {
  return (
    <Badge tone={ticketStatusTone(status)} className={cn("px-[9px] py-[3px] text-[12px] leading-[normal]", className)}>
      {label}
    </Badge>
  );
}
