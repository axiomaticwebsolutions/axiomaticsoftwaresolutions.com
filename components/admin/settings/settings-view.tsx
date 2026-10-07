import { SETTINGS_COPY, SETTINGS_SECTIONS, settingsSection, type AdminSettingsData } from "@/lib/admin/settings/model";
import { IntegrationCards } from "./integrations-panel";
import { SettingsForm, type SettingsFact } from "./settings-form";

/**
 * Settings grid (prototype: cards auto-fit at 420px minimum, 14px gaps, aligned to the top): Business details, Tax &
 * invoicing, License policy and Sample notice as forms, then the read-only integration cards. Server component; each
 * form is a client island.
 */
export function SettingsView({ data }: { data: AdminSettingsData }) {
  const values = { business: data.business, tax: data.tax, licensing: data.licensing, "sample-notice": data.sampleNotice } as const;
  const facts: Partial<Record<keyof typeof values, SettingsFact[]>> = {
    tax: [
      { label: SETTINGS_COPY.readOnlyFacts.nextInvoice, value: data.facts.nextInvoiceNumber ?? SETTINGS_COPY.readOnlyFacts.seriesFull, mono: true, help: SETTINGS_COPY.readOnlyFacts.nextInvoiceHelp },
      { label: SETTINGS_COPY.readOnlyFacts.nextCreditNote, value: data.facts.nextCreditNoteNumber ?? SETTINGS_COPY.readOnlyFacts.seriesFull, mono: true },
    ],
    licensing: [
      { label: SETTINGS_COPY.readOnlyFacts.offlineGrace, value: String(data.facts.offlineGraceDays), help: SETTINGS_COPY.readOnlyFacts.offlineGraceHelp },
      // Fixed (EXPIRING_DAYS), not a setting: every status, list, report and the portal use the same window.
      { label: SETTINGS_COPY.readOnlyFacts.expiring, value: String(data.facts.expiringDays), help: SETTINGS_COPY.readOnlyFacts.expiringHelp },
      { label: SETTINGS_COPY.readOnlyFacts.keyReveal, value: SETTINGS_COPY.readOnlyFacts.keyRevealValue },
    ],
  };
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,420px),1fr))] items-start gap-3.5">
      {SETTINGS_SECTIONS.map((def) => (
        <SettingsForm key={def.id} section={settingsSection(def.id)} value={values[def.id]} facts={facts[def.id]} />
      ))}
      <IntegrationCards integrations={data.integrations} />
    </div>
  );
}
