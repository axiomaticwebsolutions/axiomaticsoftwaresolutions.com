"use client";

import Link from "next/link";
import { Icon } from "@/components/icons/icon";
import { Badge } from "@/components/ui/badge";
import { DisabledAction } from "@/components/account/disabled-action";
import { licenseHref } from "@/components/account/licenses/model";
import { SMALL_DANGER } from "@/components/account/licenses/ui";
import { cn } from "@/lib/utils";
import { DEVICE_STATE_META, deviceIcon, deviceState, deviceSubtitle, lastSeenText } from "./model";
import type { AccountDevice } from "@/lib/licensing/account";

const RENAME_BUTTON = "grid size-7 shrink-0 cursor-pointer place-items-center rounded-8 text-ink-3 transition-colors";

/**
 * DEVICE cell: grey icon tile, name (800) and "{os} · v{version}"; with onRename a Rename button on active devices,
 * shown disabled with "Requires Owner or Technical contact" when `renameDisabled` (the role lacks devices.manage).
 */
export function DeviceNameCell({
  device,
  onRename,
  renameDisabled = false,
  withIcon = true,
}: {
  device: Pick<AccountDevice, "id" | "name" | "os" | "appVersion" | "active">;
  onRename?: () => void;
  renameDisabled?: boolean;
  withIcon?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {withIcon ? (
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-9 bg-slate-bg text-ink-2">
          <Icon name={deviceIcon(device)} size={18} />
        </span>
      ) : null}
      <span className="min-w-0 text-left">
        <span className="block whitespace-nowrap font-extrabold">{device.name}</span>
        <span className="block whitespace-nowrap text-[12px] font-semibold text-ink-2">{deviceSubtitle(device)}</span>
      </span>
      {onRename && device.active ? (
        renameDisabled ? (
          <DisabledAction perm="devices.manage" asChild>
            <button type="button" aria-label={`Rename ${device.name}`} className={RENAME_BUTTON}>
              <Icon name="border_color" size={16} />
            </button>
          </DisabledAction>
        ) : (
          <button
            type="button"
            aria-label={`Rename ${device.name}`}
            onClick={onRename}
            className={cn(RENAME_BUTTON, "hover:bg-lavender-bg hover:text-lavender-fg")}
          >
            <Icon name="border_color" size={16} />
          </button>
        )
      ) : null}
    </span>
  );
}

export function DeviceStatusBadge({ device }: { device: Pick<AccountDevice, "active" | "stale"> }) {
  const meta = DEVICE_STATE_META[deviceState(device)];
  return (
    <Badge tone={meta.tone} className="px-[9px] py-[3px] text-[12px] leading-[normal]">
      {meta.label}
    </Badge>
  );
}

export function LastSeenCell({ device, now }: { device: Pick<AccountDevice, "lastSeenAt" | "stale">; now: Date }) {
  return (
    <time dateTime={device.lastSeenAt} className={cn("whitespace-nowrap font-semibold", device.stale && "text-peach-fg")}>
      {lastSeenText(device, now)}
    </time>
  );
}

export function LicenseLinkCell({ device }: { device: Pick<AccountDevice, "licenseId" | "productShortName"> }) {
  return (
    <span className="block min-w-0">
      <Link href={licenseHref(device.licenseId)} className="rounded-6 font-bold text-primary-link no-underline hover:text-primary-link-hover hover:underline">
        {device.licenseId}
      </Link>
      <span className="block whitespace-nowrap text-[12px] font-semibold text-ink-2">{device.productShortName}</span>
    </span>
  );
}

/**
 * Row "Deactivate": shown for active devices on usable licenses; members without devices.manage get the disabled
 * button with "Requires Owner or Technical contact".
 */
export function DeactivateButton({ canManage, label, onClick }: { canManage: boolean; label: string; onClick: () => void }) {
  if (!canManage) {
    return (
      <DisabledAction perm="devices.manage" asChild>
        <button type="button" aria-label={`Deactivate ${label}`} className={SMALL_DANGER}>
          Deactivate
        </button>
      </DisabledAction>
    );
  }
  return (
    <button type="button" aria-label={`Deactivate ${label}`} onClick={onClick} className={SMALL_DANGER}>
      Deactivate
    </button>
  );
}
