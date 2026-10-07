"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger, useActiveTabInView } from "@/components/ui/tabs";
import { PageAction, PageHeader } from "@/components/account/page-header";
import { usePortal } from "@/components/account/portal-context";
import { PORTAL_PATHS } from "@/components/account/portal-nav";
import { LICENSE_STATUS_META } from "@/lib/licensing/status";
import type { LicenseDetailData } from "./data";
import { KeyCard } from "./key-card";
import { LicenseDevicesTab } from "./license-devices-tab";
import { LicenseRenewTab } from "./license-renew-tab";
import { LicenseActivityTab, LicenseOverviewTab } from "./license-tabs";
import { isTrialLicense, licenseHref, parseLicenseTab, primaryOption, type LicenseTab } from "./model";
import { AddComputersDialog, ChoosePlanDialog, useAddLicenseLines } from "./purchase-dialogs";
import { LicenseStatusBadge, ProductTile } from "./ui";

const TAB_TRIGGER =
  "px-3.5 py-2.5 text-[14px] font-bold leading-[normal] text-ink-2 hover:text-ink data-[state=active]:border-primary data-[state=active]:text-lavender-fg";

/** New ticket about this license (the ticket form may preselect it from ?license=). */
function ticketHref(licenseId: string): string {
  return `${PORTAL_PATHS.newTicket}?license=${encodeURIComponent(licenseId)}`;
}

/**
 * License detail (Customer Portal prototype "License detail"): header card, then the Overview, Devices, Activity
 * and Renew & upgrade tabs. The tab is kept in the URL (?tab=) with history.replaceState, so switching tabs never
 * reloads the data; mutations refresh the server data (router.refresh) and keep the tab. The URL is the source of
 * the tab: a link to this license (breadcrumb, search result, notification) shows the tab it names, Overview when it
 * names none (prototype "Tab resets to Overview on navigation").
 */
export function LicenseDetailView({ data }: { data: LicenseDetailData }) {
  const { can, user } = usePortal();
  const { detail, options, addon, paidPlans } = data;
  const license = detail.license;
  const now = React.useMemo(() => new Date(data.now), [data.now]);
  // Next keeps useSearchParams in step with history.replaceState, so urlTab follows tab clicks too. A click shows its
  // tab at once (local state); any other change of ?tab= (a link, the breadcrumb) replaces it.
  const urlTab = parseLicenseTab(useSearchParams().get("tab"));
  const [tab, setTab] = React.useState<LicenseTab>(urlTab);
  const [seenUrlTab, setSeenUrlTab] = React.useState(urlTab);
  if (urlTab !== seenUrlTab) {
    setSeenUrlTab(urlTab);
    setTab(urlTab);
  }
  const tabsRef = React.useRef<HTMLDivElement>(null);
  // Phones: the tab list scrolls sideways; keep the selected tab (deep links such as ?tab=renew) in view.
  useActiveTabInView(tabsRef, tab);
  const [addOpen, setAddOpen] = React.useState(false);
  const [chooseOpen, setChooseOpen] = React.useState(false);
  const addLines = useAddLicenseLines();

  const changeTab = (value: string) => {
    const next = value as LicenseTab;
    setTab(next);
    window.history.replaceState(null, "", licenseHref(license.id, next));
  };
  const showDevices = () => {
    changeTab("devices");
    window.requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>('[data-tab="devices"]')?.focus());
  };

  const canBuy = can("purchases");
  const revoked = license.status === "revoked";
  const usable = LICENSE_STATUS_META[license.status].usable;
  const trial = isTrialLicense(license);
  const primary = primaryOption(options);
  const buy = () => {
    if (primary?.tag === "BUY" && paidPlans.length > 0) setChooseOpen(true);
    else if (primary) addLines([primary.line]);
  };

  const actions = revoked ? (
    <PageAction variant="primary" icon="support_agent" href={ticketHref(license.id)} perm="tickets.create">
      Contact support
    </PageAction>
  ) : (
    <>
      {primary ? (
        <PageAction variant="primary" icon="autorenew" perm="purchases" onClick={buy}>
          {trial ? "Buy a license" : license.planType === "ONE_TIME" ? "Renew maintenance" : "Renew"}
        </PageAction>
      ) : null}
      {usable && addon?.available ? (
        <PageAction icon="add_to_queue" perm="purchases" onClick={() => setAddOpen(true)}>
          Add computers
        </PageAction>
      ) : null}
      <PageAction icon="devices" onClick={showDevices}>
        Manage devices
      </PageAction>
      <PageAction icon="support_agent" href={ticketHref(license.id)} perm="tickets.create">
        Get help
      </PageAction>
    </>
  );

  return (
    <>
      <PageHeader
        title={`${license.productShortName} · ${license.id}`}
        description="Key, devices, history and renewal options for this license."
      />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 animate-enter-up motion-reduce:animate-none">
        <section
          aria-label="License summary"
          className="flex flex-wrap items-center gap-3.5 rounded-16 border border-line-alt bg-surface px-[18px] py-4"
        >
          <ProductTile icon={license.productIcon} tone={license.productTone} size="lg" />
          <div className="min-w-0 flex-[1_1_240px]">
            <div className="text-[16px] font-extrabold">{license.productName}</div>
            <div className="text-[13px] font-semibold text-ink-2">
              {license.planName} · {license.id} · Order {license.orderId ?? "—"}
            </div>
          </div>
          <LicenseStatusBadge status={license.status} size="md" />
        </section>

        <Tabs value={tab} onValueChange={changeTab} className="grid-cols-[minmax(0,1fr)] gap-4">
          <div ref={tabsRef} className="min-w-0">
            <TabsList aria-label="License sections" className="border-line-alt">
              <TabsTrigger value="overview" data-tab="overview" className={TAB_TRIGGER}>
                Overview
              </TabsTrigger>
              <TabsTrigger value="devices" data-tab="devices" className={TAB_TRIGGER}>
                Devices ({license.devicesUsed}/{license.deviceLimit})
              </TabsTrigger>
              <TabsTrigger value="activity" data-tab="activity" className={TAB_TRIGGER}>
                Activity
              </TabsTrigger>
              <TabsTrigger value="renew" data-tab="renew" className={TAB_TRIGGER}>
                Renew &amp; upgrade
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="overview">
            <LicenseOverviewTab
              license={license}
              now={now}
              keyCard={<KeyCard licenseId={license.id} keyMasked={license.keyMasked} revoked={revoked} canReveal={can("keys.reveal")} />}
              actions={actions}
            />
          </TabsContent>
          <TabsContent value="devices">
            <LicenseDevicesTab
              license={license}
              devices={detail.devices}
              locations={detail.locations}
              now={now}
              canManage={can("devices.manage")}
            />
          </TabsContent>
          <TabsContent value="activity">
            <LicenseActivityTab history={detail.history} userName={user.name} />
          </TabsContent>
          <TabsContent value="renew">
            <LicenseRenewTab
              options={options}
              deviceLimit={license.deviceLimit}
              revoked={revoked}
              canBuy={canBuy}
              supportHref={ticketHref(license.id)}
              onCart={(option) => addLines([option.line])}
              onAddComputers={() => setAddOpen(true)}
              onChoosePlan={() => (paidPlans.length > 0 ? setChooseOpen(true) : primary && addLines([primary.line]))}
            />
          </TabsContent>
        </Tabs>
      </div>
      {addon ? <AddComputersDialog open={addOpen} onOpenChange={setAddOpen} licenseId={license.id} addon={addon} /> : null}
      {paidPlans.length > 0 ? (
        <ChoosePlanDialog
          open={chooseOpen}
          onOpenChange={setChooseOpen}
          license={license}
          plans={paidPlans}
          defaultPlanId={primary?.tag === "BUY" ? primary.planId : undefined}
        />
      ) : null}
    </>
  );
}
