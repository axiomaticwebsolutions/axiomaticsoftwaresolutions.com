import type * as React from "react";
import { AdminCardContent } from "@/components/admin/admin-card";
import { Badge } from "@/components/ui/badge";
import type { AuditRow } from "@/lib/admin/audit/model";
import { auditCardText } from "./card-text";

/** Audit card below 760px: "{actor} · {action}", "{target} · {relative}" and a slate role badge (card-text.ts). */
export function auditCard(now: string): (row: AuditRow) => React.ReactNode {
  return function AuditCard(row: AuditRow) {
    const text = auditCardText(row, now);
    return (
      <AdminCardContent
        title={text.title}
        subtitle={text.subtitle}
        badge={
          <Badge tone="slate" size="sm" className="leading-[normal]">
            {text.role}
          </Badge>
        }
      />
    );
  };
}
