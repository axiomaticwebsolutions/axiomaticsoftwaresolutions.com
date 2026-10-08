/**
 * POST /api/admin/settings/integrations/:kind/test {} -> ProbeResult { kind, source, ok, testedAt, steps[] }
 * (docs/admin-integrations-design.md section 16; integrations.manage = Owner). Tests the EFFECTIVE configuration
 * (saved in Admin, else the env file): payments = an authenticated read-only Razorpay call plus the last signed
 * webhook; email = one message to the signed-in Owner's own address; storage = put, head and delete a tiny object
 * under axs-probe/. Rate limited (10 / 10 min, 429); 409 `integration_not_configured` when there is nothing to test.
 * A failed test is still 200 with ok: false. Audited ("Tested integration"); messages never echo a key, host or
 * provider error.
 */
import { adminRoute } from "@/lib/admin/http";
import { testIntegration } from "@/lib/admin/settings/integration-actions";
import { errors, json } from "@/lib/http";
import { isIntegrationKind, probeBodySchema } from "@/lib/integrations/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = adminRoute<{ kind: string }>("integrations.manage", async ({ params, staff, actor, body }) => {
  const kind = params.kind;
  if (!isIntegrationKind(kind)) throw errors.notFound("Integration");
  await body(probeBodySchema);
  return json(await testIntegration({ staff, actor }, kind));
});
