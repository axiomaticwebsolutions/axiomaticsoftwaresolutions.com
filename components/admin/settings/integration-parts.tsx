import type * as React from "react";
import { Icon } from "@/components/icons/icon";
import { Badge } from "@/components/ui/badge";
import { INTEGRATIONS_COPY, type IntegrationState } from "@/lib/admin/settings/integrations-model";
import { formatDateTimeIST } from "@/lib/dates";
import type { ProbeResult, ProbeStepStatus } from "@/lib/integrations/types";
import { cn } from "@/lib/utils";
import { integrationBadges } from "./integration-form-model";

/**
 * Small server-safe pieces shared by the integration cards (the Owner's client form and the status-only card): the
 * badge row, the problem line, read-only facts and the test result list. Text carries the meaning; colour only
 * repeats it.
 */

export function IntegrationBadges({ state }: { state: Pick<IntegrationState, "source" | "development" | "mode"> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {integrationBadges(state).map((badge) => (
        <Badge key={badge.label} tone={badge.tone} size="sm" className="leading-[normal]">
          {badge.label}
        </Badge>
      ))}
    </div>
  );
}

/** The server file variables behind a card that uses them (NAMES only, never values): the lines to delete later. */
export function EnvNamesLine({ state }: { state: Pick<IntegrationState, "source" | "envNames"> }) {
  if (state.source !== "env" || state.envNames.length === 0) return null;
  return (
    <p className="m-0 break-words text-[12px] text-ink-2">
      {INTEGRATIONS_COPY.envNames} <span className="font-mono">{state.envNames.join(", ")}</span>
    </p>
  );
}

/** Why the integration is off (names fields or env variable NAMES, never values). */
export function IntegrationProblem({ problem }: { problem: string | null }) {
  if (!problem) return null;
  return (
    <p role="status" className="m-0 flex items-start gap-1.5 rounded-8 bg-pink-bg px-2.5 py-2 text-[13px] font-semibold text-pink-fg">
      <Icon name="error" size={17} className="mt-px shrink-0" />
      <span>{problem}</span>
    </p>
  );
}

export function FactItem({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="grid min-w-0 gap-[5px]">
      <dt className="text-[12.5px] font-bold">{label}</dt>
      <dd
        className={cn(
          "m-0 flex min-h-9 min-w-0 items-center break-all rounded-8 border border-line-input bg-bg px-2.5 py-1.5 text-[13.5px] font-semibold",
          mono && "font-mono tracking-[0.02em]",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

const STEP_STYLE: Readonly<Record<ProbeStepStatus, { icon: "check_circle" | "error" | "remove" | "info"; className: string; word: string }>> = {
  ok: { icon: "check_circle", className: "text-sage-fg", word: "Passed" },
  failed: { icon: "error", className: "text-danger", word: "Failed" },
  skipped: { icon: "remove", className: "text-ink-2", word: "Skipped" },
  info: { icon: "info", className: "text-blue-fg", word: "Note" },
};

/** One test's steps, each with an icon, the step and its message (fixed sentences; never a key or a host). */
export function ProbeSteps({ result, title }: { result: ProbeResult; title: string }) {
  return (
    <div className="grid gap-1.5 rounded-10 border border-line-subtle bg-bg px-3 py-2.5">
      <p className="m-0 text-[12.5px] font-bold">
        {title}: {result.ok ? "passed" : "failed"} <span className="font-semibold text-ink-2">({formatDateTimeIST(new Date(result.testedAt))})</span>
      </p>
      <ul className="m-0 grid list-none gap-1 p-0">
        {result.steps.map((step) => {
          const style = STEP_STYLE[step.status];
          return (
            <li key={step.id} className="flex items-start gap-1.5 text-[13px]">
              <Icon name={style.icon} size={17} className={cn("mt-px shrink-0", style.className)} />
              <span className="min-w-0">
                <span className="sr-only">{style.word}: </span>
                <span className="font-bold">{step.label}:</span> {step.message}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
