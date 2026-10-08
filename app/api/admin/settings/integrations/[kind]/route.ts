/**
 * Admin > Settings > Integrations (docs/admin-integrations-design.md section 14; integrations.manage = Owner).
 *
 * PUT /api/admin/settings/integrations/:kind (payments | email | storage) with the save body of that kind
 * (lib/integrations/model.ts INTEGRATION_SAVE_SCHEMAS: currentPassword, revision, the fields; an empty or missing secret
 * keeps the stored one) -> { integration, changed }. In order: unknown kind 404; body 422 with field errors; password
 * re-entry 429 / 422 `incorrect_password` (fieldErrors.currentPassword); host checks 422 (private address, unknown host,
 * https); 409 `integration_changed` for a stale revision; 422 naming a required secret that is neither stored nor
 * entered. Saves encrypted, audits the changed fields by label and invalidates the resolver cache.
 *
 * DELETE /api/admin/settings/integrations/:kind { currentPassword } -> { integration }: removes the saved settings (the
 * env file becomes the fallback again); 409 `integration_not_saved` when nothing is saved.
 *
 * Never returns a secret: the integration view carries "set", the last 4 characters of long secrets, when and by whom.
 */
import { adminRoute } from "@/lib/admin/http";
import { removeIntegration, saveIntegration } from "@/lib/admin/settings/integration-actions";
import { errors, json } from "@/lib/http";
import { INTEGRATION_SAVE_SCHEMAS, isIntegrationKind, passwordConfirmSchema, type IntegrationKind, type IntegrationSaveBody } from "@/lib/integrations/model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function kindParam(params: { kind?: string }): IntegrationKind {
  const kind = params.kind;
  if (!isIntegrationKind(kind)) throw errors.notFound("Integration");
  return kind;
}

export const PUT = adminRoute<{ kind: string }>("integrations.manage", async ({ params, staff, actor, body }) => {
  const kind = kindParam(params);
  const input = (await body(INTEGRATION_SAVE_SCHEMAS[kind])) as IntegrationSaveBody<typeof kind>;
  return json(await saveIntegration({ staff, actor }, kind, input));
});

export const DELETE = adminRoute<{ kind: string }>("integrations.manage", async ({ params, staff, actor, body }) => {
  const kind = kindParam(params);
  const { currentPassword } = await body(passwordConfirmSchema);
  return json(await removeIntegration({ staff, actor }, kind, currentPassword));
});
