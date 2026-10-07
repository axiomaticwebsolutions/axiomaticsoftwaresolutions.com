/**
 * Browser calls of the device views (client components only): rename/move (PATCH /api/account/devices/:id) and
 * self-service deactivation (POST /api/account/licenses/:id/devices/:deviceId/deactivate). apiFetch adds the CSRF
 * token; errors arrive as ApiClientError with the server's user-facing message.
 */
import { ApiClientError, apiFetch, UNEXPECTED_ERROR_MESSAGE } from "@/lib/client/api";

export type DeviceTarget = { id: string; licenseId: string; name: string };

export function updateDevice(deviceId: string, changes: { name?: string; locationId?: string | null }): Promise<unknown> {
  return apiFetch(`/api/account/devices/${encodeURIComponent(deviceId)}`, { method: "PATCH", body: changes });
}

export function deactivateDevice(device: Pick<DeviceTarget, "id" | "licenseId">): Promise<unknown> {
  const path = `/api/account/licenses/${encodeURIComponent(device.licenseId)}/devices/${encodeURIComponent(device.id)}/deactivate`;
  return apiFetch(path, { method: "POST", body: {} });
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.status === 401 ? "Your session has ended. Sign in again." : error.message;
  return UNEXPECTED_ERROR_MESSAGE;
}

export type DeactivationRun = { ok: DeviceTarget[]; failed: DeviceTarget[]; lastError: string | null };

/**
 * Deactivates devices one by one (each request is checked and counted by the server). After a license answers 429
 * `reset_limit`, its remaining devices are not tried.
 */
export async function runDeactivations(devices: readonly DeviceTarget[]): Promise<DeactivationRun> {
  const ok: DeviceTarget[] = [];
  const failed: DeviceTarget[] = [];
  const limited = new Set<string>();
  let lastError: string | null = null;
  for (const device of devices) {
    if (limited.has(device.licenseId)) {
      failed.push(device);
      continue;
    }
    try {
      await deactivateDevice(device);
      ok.push(device);
    } catch (error) {
      failed.push(device);
      lastError = errorMessage(error);
      if (error instanceof ApiClientError && error.code === "reset_limit") limited.add(device.licenseId);
      // Signed out or the account changed: nothing else will work either.
      if (error instanceof ApiClientError && (error.status === 401 || error.code === "no_account")) break;
    }
  }
  return { ok, failed, lastError };
}
