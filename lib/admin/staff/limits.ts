/**
 * Rate limits of the staff invitation flow (lib/auth/rate-limit.ts rules shape; RATE_LIMITS belongs to another area,
 * so these live here until they are moved there):
 * - invite: 20 per hour per inviting Owner;
 * - resend: 3 per hour per invited person;
 * - preview of /staff-invite?token=: 60 per 10 minutes per IP;
 * - accept: 20 per 15 minutes per IP.
 * Keys carry staff ids (cuids) and the IP bucket (lib/http ipBucket), never emails or tokens.
 */
import type { RateLimitRule } from "@/lib/auth/rate-limit";
import { ipBucket } from "@/lib/http";

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const STAFF_RATE_LIMITS = {
  invite: (staffId: string): RateLimitRule => ({ key: `staff-invite:by:${staffId}`, limit: 20, windowSec: HOUR }),
  resend: (inviteeId: string): RateLimitRule => ({ key: `staff-invite-resend:user:${inviteeId}`, limit: 3, windowSec: HOUR }),
  previewIp: (ip: string | null | undefined): RateLimitRule => ({
    key: `staff-invite-preview:ip:${ipBucket(ip)}`,
    limit: 60,
    windowSec: 10 * MINUTE,
  }),
  acceptIp: (ip: string | null | undefined): RateLimitRule => ({
    key: `staff-invite-accept:ip:${ipBucket(ip)}`,
    limit: 20,
    windowSec: 15 * MINUTE,
  }),
} as const;
