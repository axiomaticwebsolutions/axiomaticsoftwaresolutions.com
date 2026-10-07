/** Strict request body of POST /api/admin/renewals/remind. Pure. */
import { z } from "zod";
import { ADMIN_ID_RE } from "@/lib/admin/licenses/schemas";
import { REMIND_MAX_LICENSES } from "./model";

export const remindBody = z.strictObject({
  licenseIds: z
    .array(z.string().regex(ADMIN_ID_RE, "Choose a valid license."))
    .min(1, "Select at least one license.")
    .max(REMIND_MAX_LICENSES, `Select at most ${REMIND_MAX_LICENSES} licenses.`),
});
