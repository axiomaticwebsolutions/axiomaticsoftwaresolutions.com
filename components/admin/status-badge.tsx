import { statusMeta, type StatusKind, type StatusTone } from "@/components/admin/model";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export { STATUS_META, humanizeStatus, statusMeta, type StatusKind, type StatusMeta, type StatusTone } from "@/components/admin/model";

export type StatusBadgeProps = {
  kind: StatusKind;
  status: string | null | undefined;
  /** Text instead of the mapped label. */
  label?: string;
  /** Tone instead of the mapped one. */
  tone?: StatusTone;
  /** sm = table cells and drawer headers (2x8px, 11.5px/800); md = larger contexts. */
  size?: "sm" | "md";
  className?: string;
};

/** Status pill for admin tables, cards and drawers (Admin Console.dc.html badge). Server-safe. */
export function StatusBadge({ kind, status, label, tone, size = "sm", className }: StatusBadgeProps) {
  const meta = statusMeta(kind, status);
  return (
    <Badge tone={tone ?? meta.tone} size={size} className={cn("leading-[normal]", className)}>
      {label ?? meta.label}
    </Badge>
  );
}
