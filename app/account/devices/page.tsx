import type { Metadata } from "next";
import { loadDeviceFleet } from "@/components/account/devices/data";
import { DevicesView } from "@/components/account/devices/devices-view";
import { getPortalContext } from "@/lib/portal/context";

export const metadata: Metadata = { title: "Devices" };

/**
 * Device fleet (decisions.md Phase 5): every device on the active account's licenses, any team role. Filters live in
 * the URL (?q=&status=&location=) and run in the browser; changes go through the /api/account/devices and
 * /api/account/licenses/:id/devices/:deviceId/deactivate routes, which check the role again.
 */
export default async function DevicesPage() {
  const ctx = await getPortalContext();
  const data = await loadDeviceFleet({ accountId: ctx.account.id, role: ctx.role });
  return <DevicesView data={data} />;
}
