/**
 * DELETE /api/admin/settings/integrations/:kind/secrets/:field { currentPassword } -> { integration, cleared }
 * (docs/admin-integrations-design.md section 14; integrations.manage = Owner). Clears one saved secret: keySecret or
 * webhookSecret (payments), password (email), secretAccessKey (storage); anything else 404. Password re-entry as for a
 * save (429 / 422 `incorrect_password`); 409 `integration_not_saved` when nothing is saved for the kind; a secret that
 * is not set answers 200 with `cleared: false` and changes nothing. A cleared required secret turns the integration
 * off ("Not configured"); the env file is NOT used instead. Audited by field label; never returns a secret.
 */
import { adminRoute } from "@/lib/admin/http";
import { clearSecret } from "@/lib/admin/settings/integration-actions";
import { errors, json } from "@/lib/http";
import { isIntegrationKind, isSecretField, passwordConfirmSchema } from "@/lib/integrations/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = adminRoute<{ kind: string; field: string }>("integrations.manage", async ({ params, staff, actor, body }) => {
  const kind = params.kind;
  if (!isIntegrationKind(kind)) throw errors.notFound("Integration");
  const field = params.field;
  if (!isSecretField(kind, field)) throw errors.notFound("Secret");
  const { currentPassword } = await body(passwordConfirmSchema);
  return json(await clearSecret({ staff, actor }, kind, field, currentPassword));
});
