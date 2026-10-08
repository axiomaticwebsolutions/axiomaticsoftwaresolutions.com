import { Badge } from "@/components/ui/badge";
import { INTEGRATIONS_COPY, type IntegrationsData, type IntegrationState, type RedisState } from "@/lib/admin/settings/integrations-model";
import { READ_ONLY_FOR_ROLE } from "@/lib/rbac";
import { IntegrationCard } from "./integration-card";
import { statusFacts } from "./integration-form-model";
import { EnvNamesLine, FactItem, IntegrationBadges, IntegrationProblem } from "./integration-parts";
import { SETTINGS_GRID_CLASS, SettingsCard } from "./settings-card";

const REDIS_TONES = { configured: "sage", missing: "pink", development: "peach" } as const;

/**
 * An integration for a viewer without integrations.manage: provider, source and mode only, plus "Read only for your
 * role". No inputs, no values and no secret hints (the server does not send them either). Server component.
 */
export function IntegrationStatusCard({ state }: { state: IntegrationState }) {
  return (
    <SettingsCard
      id={`integration-${state.id}`}
      headingLevel={3}
      icon={state.icon}
      title={state.title}
      description={state.description}
      note={READ_ONLY_FOR_ROLE}
    >
      <div className="grid gap-2.5 px-4 pt-3.5">
        <IntegrationBadges state={state} />
        <EnvNamesLine state={state} />
        <IntegrationProblem problem={state.problem} />
      </div>
      <dl className={`m-0 ${SETTINGS_GRID_CLASS}`}>
        {statusFacts(state).map((fact) => (
          <FactItem key={fact.label} label={fact.label}>
            {fact.value}
          </FactItem>
        ))}
      </dl>
    </SettingsCard>
  );
}

/** Rate limits: REDIS_URL stays in the server file (a wrong value would block every sign-in). Read-only for everyone. */
export function RedisCard({ redis }: { redis: RedisState }) {
  return (
    <SettingsCard
      id="integration-redis"
      headingLevel={3}
      icon={redis.icon}
      title={redis.title}
      description={redis.description}
      note={redis.note}
    >
      <dl className={`m-0 ${SETTINGS_GRID_CLASS}`}>
        <FactItem label={INTEGRATIONS_COPY.facts.provider}>{redis.provider}</FactItem>
        <FactItem label="Status">
          <Badge tone={REDIS_TONES[redis.status]} size="sm" className="leading-[normal]">
            {INTEGRATIONS_COPY.redis.statuses[redis.status]}
          </Badge>
        </FactItem>
        <FactItem label="Server setting" mono>
          {redis.envNames.join(", ")}
        </FactItem>
      </dl>
    </SettingsCard>
  );
}

/**
 * Admin > Settings > Integrations (docs/admin-integrations-design.md section 17): payments, storage and email as forms
 * for the Owner (integrations.manage) or status-only cards for anyone else, then the read-only rate-limits card. Spans
 * the settings grid and keeps its card columns. Server component; each form is a client island.
 */
export function IntegrationsPanel({ data }: { data: IntegrationsData }) {
  return (
    <section aria-labelledby="integrations-heading" className="col-span-full grid min-w-0 gap-3">
      <div className="min-w-0">
        <h2 id="integrations-heading" className="m-0 text-[16px] font-extrabold">
          {INTEGRATIONS_COPY.title}
        </h2>
        <p className="m-0 mt-0.5 text-[12.5px] text-ink-2">{INTEGRATIONS_COPY.description}</p>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-3.5">
        {data.items.map((item) =>
          data.canManage && item.form ? (
            <IntegrationCard key={item.id} initial={{ ...item, form: item.form }} />
          ) : (
            <IntegrationStatusCard key={item.id} state={item} />
          ),
        )}
        <RedisCard redis={data.redis} />
      </div>
    </section>
  );
}
