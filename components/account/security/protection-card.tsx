"use client";

import * as React from "react";
import { downloadFromApi } from "@/components/account/activity/download-file";
import { PermissionAction } from "@/components/account/disabled-action";
import { PortalConfirmDialog } from "@/components/account/team/portal-confirm-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Switch } from "@/components/ui/switch";
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";
import { SECURITY_CARD } from "./security-parts";
import { exportedToast, SECURITY_COPY } from "./security-model";

export type ProtectionCardProps = {
  twoStepEnabled: boolean;
  /**
   * The portal's "Account data" export (Owner only; reads the portal context, so it needs the portal layout). Off in
   * Admin > My profile, where the card is only the two-step switch. Default true.
   */
  accountData?: boolean;
};

type TwoStepResponse = { twoStepEnabled: boolean; changed: boolean };

const EXPORT_BUTTON = "h-auto rounded-9 px-3.5 py-2 text-[13.5px] leading-[normal]";

/**
 * Two-step verification switch and "Account data" (prototype card). Turning two-step on is immediate; turning it off
 * asks for the account password (decisions.md Phase 5). The note under the switch says codes come by email, so it is
 * only safe once email sending works (decisions.md 2026-10-08). "Export data" downloads the JSON account export
 * (GET /api/account/export, Owner only: other roles see it disabled with "Requires Owner"). Staff use the same card
 * in Admin > My profile with `accountData={false}` (POST /api/me/two-step serves both).
 */
export function ProtectionCard({ twoStepEnabled, accountData = true }: ProtectionCardProps) {
  const [enabled, setEnabled] = React.useState(twoStepEnabled);
  const [busy, setBusy] = React.useState(false);
  const [confirmOff, setConfirmOff] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);

  async function toggle(next: boolean) {
    if (busy) return;
    if (!next) {
      setConfirmOff(true);
      return;
    }
    setBusy(true);
    try {
      const result = await apiFetch<TwoStepResponse>("/api/me/two-step", { method: "POST", body: { enabled: true } });
      setEnabled(result.twoStepEnabled);
      toast.success(SECURITY_COPY.twoStepOn);
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff({ password }: { password: string }) {
    const result = await apiFetch<TwoStepResponse>("/api/me/two-step", { method: "POST", body: { enabled: false, password } });
    setEnabled(result.twoStepEnabled);
    toast.success(SECURITY_COPY.twoStepOff);
  }

  async function exportData() {
    if (exporting) return;
    setExporting(true);
    try {
      const { fileName } = await downloadFromApi("/api/account/export", SECURITY_COPY.exportFallbackName);
      toast.success(exportedToast(fileName));
    } catch (error) {
      toast.error(error instanceof ApiClientError ? error.message : UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setExporting(false);
    }
  }

  return (
    <section
      aria-label={accountData ? `${SECURITY_COPY.twoStepHeading} and ${SECURITY_COPY.dataHeading.toLowerCase()}` : SECURITY_COPY.twoStepHeading}
      className={`${SECURITY_CARD} grid gap-3.5 px-[18px] py-4`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="security-two-step-heading" className="m-0 text-[15px] font-extrabold">
            {SECURITY_COPY.twoStepHeading}
          </h2>
          <p id="security-two-step-body" className="mb-0 mt-1 text-[13.5px] leading-[1.5] text-ink-2">
            {SECURITY_COPY.twoStepBody}
          </p>
          <p id="security-two-step-email" className="mb-0 mt-1.5 text-[13px] font-semibold leading-[1.5] text-ink-2">
            {SECURITY_COPY.twoStepEmailNote}
          </p>
        </div>
        <Switch
          checked={enabled}
          onCheckedChange={(next) => void toggle(next)}
          aria-labelledby="security-two-step-heading"
          aria-describedby="security-two-step-body security-two-step-email"
          aria-busy={busy || undefined}
          className="mt-0.5"
        />
      </div>
      {accountData ? (
        <>
          <div aria-hidden="true" className="h-px bg-line-subtle" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="m-0 text-[15px] font-extrabold">{SECURITY_COPY.dataHeading}</h2>
              <p className="mb-0 mt-1 text-[13.5px] leading-[1.5] text-ink-2">{SECURITY_COPY.dataBody}</p>
            </div>
            <PermissionAction perm="team.manage">
              <Button type="button" variant="secondary" loading={exporting} onClick={exportData} className={EXPORT_BUTTON}>
                {SECURITY_COPY.exportData}
              </Button>
            </PermissionAction>
          </div>
        </>
      ) : null}
      <PortalConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title={SECURITY_COPY.twoStepOffTitle}
        description={SECURITY_COPY.twoStepOffBody}
        confirmLabel={SECURITY_COPY.twoStepOffCta}
        tone="danger"
        password
        onConfirm={turnOff}
      />
    </section>
  );
}
