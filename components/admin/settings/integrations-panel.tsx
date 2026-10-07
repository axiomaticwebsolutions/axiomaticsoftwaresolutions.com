import type * as React from "react";
import { StatusBadge } from "@/components/admin/status-badge";
import type { StatusTone } from "@/components/admin/model";
import { INTEGRATION_STATUS_LABELS, SETTINGS_COPY, type IntegrationStatus, type IntegrationView } from "@/lib/admin/settings/model";
import { SETTINGS_GRID_CLASS, SettingsCard } from "./settings-card";

const STATUS_TONES: Record<IntegrationStatus, StatusTone> = { configured: "sage", missing: "pink", development: "peach" };

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-[5px]">
      <dt className="text-[12.5px] font-bold">{label}</dt>
      <dd className="m-0 flex h-9 min-w-0 items-center rounded-8 border border-line-input bg-bg px-2.5 text-[13.5px] font-semibold">
        {children}
      </dd>
    </div>
  );
}

/**
 * Integration cards (prototype payment provider, installer storage, email delivery; plus rate limits): driver kind,
 * configured / not configured / development only, and the payment mode. Read-only: secrets live in env and are never
 * shown or stored here, so there is no Save. Server-safe.
 */
export function IntegrationCards({ integrations }: { integrations: readonly IntegrationView[] }) {
  return integrations.map((item) => (
    <SettingsCard key={item.id} id={`integration-${item.id}`} icon={item.icon} title={item.title} description={item.description} note={item.note}>
      <dl className={`m-0 ${SETTINGS_GRID_CLASS}`}>
          <Fact label={SETTINGS_COPY.fields.provider}>{item.provider}</Fact>
          <Fact label={SETTINGS_COPY.fields.status}>
            <StatusBadge kind="staff" status={item.status} label={INTEGRATION_STATUS_LABELS[item.status]} tone={STATUS_TONES[item.status]} />
          </Fact>
          {item.mode ? (
            <Fact label={SETTINGS_COPY.fields.mode}>
              <StatusBadge kind="staff" status={item.mode} label={SETTINGS_COPY.modes[item.mode]} tone={item.mode === "test" ? "peach" : "sage"} />
            </Fact>
          ) : null}
      </dl>
    </SettingsCard>
  ));
}
