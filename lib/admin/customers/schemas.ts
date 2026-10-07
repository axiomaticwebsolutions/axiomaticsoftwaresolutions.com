/** Strict request bodies of the admin customer routes. Pure. */
import { z } from "zod";
import { ADMIN_ID_RE } from "@/lib/admin/licenses/schemas";

/** Resend verification / send password reset: the account's first active Owner, or `userId` (a member). */
export const customerEmailActionBody = z.strictObject({
  userId: z.string().regex(ADMIN_ID_RE, "Choose a member of this account.").optional(),
});
