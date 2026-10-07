import type { IconName } from "@/components/icons/icon";
import type { BadgeTone } from "@/components/ui/badge";

/** Gallery sample of the portal license status map (tones from the Customer Portal prototype). */
export const LICENSE_STATES = {
  active: { label: "Active", tone: "sage", icon: "check_circle" },
  trial: { label: "Trial", tone: "blue", icon: "timer" },
  expiring: { label: "Expiring soon", tone: "peach", icon: "event_upcoming" },
  expired: { label: "Expired", tone: "peach", icon: "event_busy" },
  suspended: { label: "Suspended", tone: "pink", icon: "pause_circle" },
  revoked: { label: "Revoked", tone: "pink", icon: "block" },
} as const satisfies Record<string, { label: string; tone: BadgeTone; icon: IconName }>;

export type LicenseStateKey = keyof typeof LICENSE_STATES;
