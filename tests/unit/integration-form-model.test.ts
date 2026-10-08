/**
 * Admin > Settings > Integrations forms (components/admin/settings/integration-form-model.ts; docs/admin-integrations-
 * design.md section 17): drafts and PUT bodies (an empty secret is left out = keep), dirty detection, client checks with
 * the server's schemas, presets and linked fields, the test button, badges and the status-only facts. Unit tests cannot
 * import .tsx (tsconfig jsx: preserve), so the status-only card and the secret inputs are checked in their source.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  applyPreset,
  applyRegion,
  applySecurity,
  bodyFor,
  cardNote,
  clientErrors,
  dirtyKeys,
  fieldDomKey,
  hasChanges,
  INTEGRATION_FIELDS,
  integrationBadges,
  presetHint,
  providerSwitchNote,
  secretHintSource,
  secretInputHint,
  secretsRemovedBySave,
  secretsToReenter,
  secretSummary,
  serverFieldErrors,
  statusFacts,
  testButtonState,
  toDraft,
  visibleFields,
} from "@/components/admin/settings/integration-form-model";
import type { IntegrationForm, SecretHint } from "@/lib/admin/settings/integrations-model";
import { FIELD_LABELS, paymentsSaveSchema, sesSaveSchema, smtpSaveSchema, storageSaveSchema, INTEGRATION_SAVE_SCHEMAS } from "@/lib/integrations/model";

const UNSET: SecretHint = { set: false, last4: null, updatedAt: null, updatedBy: null };
const SET: SecretHint = { set: true, last4: "1a2b", updatedAt: "2026-10-08T08:30:00.000Z", updatedBy: "Asha Rao" };

const payments = (secrets: { keySecret: SecretHint; webhookSecret: SecretHint } = { keySecret: UNSET, webhookSecret: UNSET }): IntegrationForm => ({
  kind: "payments",
  prefilledFrom: "defaults",
  values: { keyId: "rzp_test_AbCdEf123456" },
  secrets,
  webhookUrl: "https://shop.example/api/webhooks/payments/razorpay",
  lastSignedWebhookAt: null,
});
const email = (password: SecretHint = UNSET, secretAccessKey: SecretHint = UNSET, provider: "smtp" | "ses" = "smtp"): IntegrationForm => ({
  kind: "email",
  prefilledFrom: "admin",
  values: {
    provider,
    host: "smtp.mailer.example",
    port: 587,
    security: "starttls",
    username: "",
    region: "ap-south-1",
    accessKeyId: provider === "ses" ? "AKIAIOSFODNN7EXAMPLE" : "",
    configurationSet: "",
    fromName: "Axiomatic",
    fromAddress: "no-reply@axiomatic.example",
  },
  secrets: { password, secretAccessKey },
});
const storage = (secretAccessKey: SecretHint = SET): IntegrationForm => ({
  kind: "storage",
  prefilledFrom: "admin",
  values: { preset: "r2", endpoint: "https://acc123.r2.cloudflarestorage.com", region: "auto", bucket: "axs-files", accessKeyId: "a1b2c3d4", forcePathStyle: true },
  secrets: { secretAccessKey },
});

describe("fields", () => {
  it("cover every save-body field once, labelled like the server's audit and errors", () => {
    const bodyKeys = (...shapes: Record<string, unknown>[]) =>
      [...new Set(shapes.flatMap((s) => Object.keys(s)))].filter((k) => k !== "currentPassword" && k !== "revision").sort();
    const expected = {
      payments: bodyKeys(paymentsSaveSchema.shape),
      email: bodyKeys(smtpSaveSchema.shape, sesSaveSchema.shape),
      storage: bodyKeys(storageSaveSchema.shape),
    };
    for (const kind of ["payments", "email", "storage"] as const) {
      const keys = INTEGRATION_FIELDS[kind].map((f) => f.key);
      expect(new Set(keys).size, kind).toBe(keys.length);
      expect([...keys].sort(), kind).toEqual(expected[kind]);
      for (const f of INTEGRATION_FIELDS[kind]) expect(f.label, f.key).toBe((FIELD_LABELS[kind] as Record<string, string>)[f.key]);
    }
    expect(INTEGRATION_FIELDS.payments.filter((f) => f.kind === "secret").map((f) => f.key)).toEqual(["keySecret", "webhookSecret"]);
    // Each email provider shows exactly its own save-body fields.
    const shown = (provider: string) => visibleFields("email", { provider }).map((f) => f.key).sort();
    expect(shown("smtp")).toEqual(bodyKeys(smtpSaveSchema.shape));
    expect(shown("ses")).toEqual(bodyKeys(sesSaveSchema.shape));
  });

  it("give identifier and secret inputs ids and names that do not look like a sign-in field", () => {
    const keys = Object.values(INTEGRATION_FIELDS).flatMap((fields) => fields.map(fieldDomKey));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key, key).not.toMatch(/user|login|e-?mail/i);
    const domKey = (kind: keyof typeof INTEGRATION_FIELDS, key: string) => fieldDomKey(INTEGRATION_FIELDS[kind].find((f) => f.key === key) ?? { key });
    expect(domKey("email", "username")).toBe("smtp-auth-id");
    expect(domKey("payments", "keyId")).toBe("razorpay-key-id");
    expect(domKey("storage", "accessKeyId")).not.toBe(domKey("email", "accessKeyId"));
  });
});

describe("drafts and bodies", () => {
  it("never prefills a secret and leaves an empty one out of the body (keep the stored one)", () => {
    const draft = toDraft(storage());
    expect(draft).toEqual({ preset: "r2", endpoint: "https://acc123.r2.cloudflarestorage.com", region: "auto", bucket: "axs-files", accessKeyId: "a1b2c3d4", forcePathStyle: true, secretAccessKey: "" });
    expect(bodyFor("storage", draft, "pw", 4)).toEqual({ currentPassword: "pw", revision: 4, preset: "r2", endpoint: "https://acc123.r2.cloudflarestorage.com", region: "auto", bucket: "axs-files", accessKeyId: "a1b2c3d4", forcePathStyle: true });
    expect(bodyFor("storage", { ...draft, secretAccessKey: "   " }, "pw", 4)).not.toHaveProperty("secretAccessKey");
    expect(bodyFor("storage", { ...draft, secretAccessKey: "new-secret-key-01" }, "pw", 4)).toMatchObject({ secretAccessKey: "new-secret-key-01" });
    const mail = bodyFor("email", { ...toDraft(email()), port: " 465 " }, "pw", null);
    expect(mail).toMatchObject({ revision: null, provider: "smtp", port: 465, username: "" });
    expect(mail).not.toHaveProperty("password");
    for (const sesOnly of ["region", "accessKeyId", "secretAccessKey", "configurationSet"]) expect(mail).not.toHaveProperty(sesOnly);
    expect(INTEGRATION_SAVE_SCHEMAS.email.safeParse(mail).success).toBe(true);
  });

  it("switches the email provider: only the chosen provider's fields show, count as changes and are sent", () => {
    const form = email(SET);
    const base = toDraft(form);
    expect(base).toMatchObject({ provider: "smtp", region: "ap-south-1", accessKeyId: "", configurationSet: "", password: "", secretAccessKey: "" });
    const ses = { ...base, provider: "ses", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "ses-secret-access-key-01", host: "ignored.example" };
    expect(visibleFields("email", ses).map((f) => f.key)).toEqual(["provider", "region", "accessKeyId", "secretAccessKey", "configurationSet", "fromName", "fromAddress"]);
    expect(dirtyKeys("email", base, ses)).toEqual(["provider", "accessKeyId", "secretAccessKey"]);
    const body = bodyFor("email", ses, "pw", 2);
    expect(body).toEqual({
      currentPassword: "pw",
      revision: 2,
      provider: "ses",
      region: "ap-south-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "ses-secret-access-key-01",
      configurationSet: "",
      fromName: "Axiomatic",
      fromAddress: "no-reply@axiomatic.example",
    });
    expect(INTEGRATION_SAVE_SCHEMAS.email.safeParse(body).success).toBe(true);
    // Back to SMTP: nothing SES-only is sent and the saved password counts again.
    expect(dirtyKeys("email", base, { ...ses, provider: "smtp", host: "smtp.mailer.example", secretAccessKey: "" })).toEqual([]);
  });

  it("detects changes: values compared trimmed, a secret counts once something is typed, a first save always counts", () => {
    const form = email();
    const base = toDraft(form);
    expect(dirtyKeys("email", base, { ...base })).toEqual([]);
    expect(dirtyKeys("email", base, { ...base, host: " smtp.mailer.example " })).toEqual([]);
    expect(dirtyKeys("email", base, { ...base, port: "465", password: "x" })).toEqual(["port", "password"]);
    expect(hasChanges({ saved: { revision: 1, updatedAt: "", updatedBy: null } }, "email", base, base)).toBe(false);
    expect(hasChanges({ saved: null }, "email", base, base)).toBe(true);
    const s = toDraft(storage());
    expect(dirtyKeys("storage", s, { ...s, forcePathStyle: false })).toEqual(["forcePathStyle"]);
  });
});

describe("client checks", () => {
  it("use the server's messages and ask for required secrets that are neither saved nor entered", () => {
    const fresh = payments();
    expect(clientErrors(fresh, toDraft(fresh), null)).toEqual({ keySecret: "Enter the key secret.", webhookSecret: "Enter the webhook secret." });
    const bad = { ...toDraft(fresh), keyId: "rzp_test_pending", keySecret: "change-me-please", webhookSecret: "short" };
    expect(clientErrors(fresh, bad, null)).toEqual({
      keyId: "Enter a Key ID that starts with rzp_test_ or rzp_live_.",
      keySecret: "This looks like a placeholder. Enter the real value.",
      webhookSecret: "Enter at least 16 characters.",
    });
    const saved = payments({ keySecret: SET, webhookSecret: SET });
    expect(clientErrors(saved, toDraft(saved), 2)).toEqual({});
  });

  it("asks for the SMTP password only with a username, and for an endpoint outside AWS", () => {
    const mail = email();
    expect(clientErrors(mail, toDraft(mail), 1)).toEqual({});
    expect(clientErrors(mail, { ...toDraft(mail), username: "mailer" }, 1)).toEqual({ password: "Enter the password." });
    expect(clientErrors(email(SET), { ...toDraft(email(SET)), username: "mailer" }, 1)).toEqual({});
    expect(clientErrors(mail, { ...toDraft(mail), port: "70000", fromAddress: "nobody" }, 1)).toEqual({
      port: "Enter a port from 1 to 65535.",
      fromAddress: "Enter an email address such as no-reply@example.com.",
    });
    const bucket = storage();
    // A new endpoint also needs the saved secret again (covered below), so these drafts enter one.
    const fresh = { ...toDraft(bucket), secretAccessKey: "new-secret-key-01" };
    expect(clientErrors(bucket, { ...fresh, endpoint: "" }, 1)).toEqual({ endpoint: "Enter the endpoint." });
    expect(clientErrors(bucket, { ...fresh, preset: "aws", endpoint: "" }, 1)).toEqual({});
    expect(clientErrors(bucket, { ...fresh, endpoint: "https://acc.example/path?x=1" }, 1)).toHaveProperty("endpoint");
  });

  it("keeps the password error for the dialog and the first message per field for the card", () => {
    expect(serverFieldErrors({ currentPassword: ["Incorrect password."], host: ["This host points to a private network address.", "x"], "endpoint.0": ["Use an https:// address."] })).toEqual({
      host: "This host points to a private network address.",
      endpoint: "Use an https:// address.",
    });
  });
});

describe("saved secrets and a new server", () => {
  it("ask for the saved secrets again when the SMTP server or the endpoint changes, not for other fields", () => {
    const mail = email(SET);
    const base = toDraft(mail);
    expect(secretsToReenter(mail, base)).toEqual([]);
    expect(secretsToReenter(mail, { ...base, fromName: "Axiomatic Software", username: "mailer" })).toEqual([]);
    // Case and spacing of the host do not count as a new server.
    expect(secretsToReenter(mail, { ...base, host: " SMTP.Mailer.Example " })).toEqual([]);
    for (const change of [{ host: "smtp.other.example" }, { port: "2525" }, applySecurity(base, "tls")]) {
      expect(secretsToReenter(mail, { ...base, ...change }), JSON.stringify(change)).toEqual(["password"]);
    }
    const moved = { ...base, host: "smtp.other.example" };
    expect(clientErrors(mail, moved, 3)).toEqual({ password: "Enter it again: the email provider, server or region changed." });
    expect(clientErrors(mail, { ...moved, password: "new-smtp-password" }, 3)).toEqual({});
    // Nothing saved yet: nothing to enter again.
    expect(secretsToReenter(email(UNSET), moved)).toEqual([]);

    const bucket = storage(SET);
    const sBase = toDraft(bucket);
    expect(secretsToReenter(bucket, { ...sBase, bucket: "axs-files-2", region: "auto" })).toEqual([]);
    expect(secretsToReenter(bucket, { ...sBase, endpoint: "https://acc123.r2.cloudflarestorage.com/" })).toEqual([]);
    expect(secretsToReenter(bucket, { ...sBase, endpoint: "https://acc999.r2.cloudflarestorage.com" })).toEqual(["secretAccessKey"]);
    expect(clientErrors(bucket, applyPreset(sBase, "spaces"), 2)).toEqual({ secretAccessKey: "Enter it again: the endpoint changed." });
    // Payments: the Razorpay address is fixed.
    expect(secretsToReenter(payments({ keySecret: SET, webhookSecret: SET }), { ...toDraft(payments()), keyId: "rzp_live_AbCdEf123456" })).toEqual([]);
    // The hint under the reopened secret names what changed, per integration.
    expect(secretInputHint({ kind: "email", replacing: true, source: "admin", saved: true, unused: true, reenter: true })).toBe(
      "The provider, server or region changed, so the saved value can’t be kept.",
    );
    expect(secretInputHint({ kind: "storage", replacing: true, source: "admin", saved: true, unused: false, reenter: true })).toBe(
      "The endpoint changed, so the saved value can’t be kept.",
    );
  });

  it("Amazon SES: needs the secret access key, asks for it again after a region change, never for the SMTP password", () => {
    const fresh = email(UNSET, UNSET, "smtp");
    const switched = { ...toDraft(fresh), provider: "ses", accessKeyId: "AKIAIOSFODNN7EXAMPLE" };
    expect(clientErrors(fresh, switched, 1)).toEqual({ secretAccessKey: "Enter the secret access key." });
    expect(clientErrors(fresh, { ...switched, accessKeyId: "akia", region: "mars-1", configurationSet: "bad set" }, 1)).toEqual({
      accessKeyId: "Enter the access key ID: capital letters and digits, usually starting with AKIA.",
      region: "Choose a region where Amazon SES is available.",
      configurationSet: "Use letters, digits, hyphens and underscores only (up to 64), or leave it empty.",
      secretAccessKey: "Enter the secret access key.",
    });
    // A saved SMTP password is not used by SES: switching never asks for it, only for the SES key.
    const smtpSaved = email(SET, UNSET, "smtp");
    const toSes = { ...toDraft(smtpSaved), provider: "ses", accessKeyId: "AKIAIOSFODNN7EXAMPLE" };
    expect(secretsToReenter(smtpSaved, toSes)).toEqual([]);
    expect(clientErrors(smtpSaved, toSes, 1)).toEqual({ secretAccessKey: "Enter the secret access key." });

    const sesSaved = email(UNSET, SET, "ses");
    const sBase = toDraft(sesSaved);
    expect(clientErrors(sesSaved, sBase, 4)).toEqual({});
    expect(secretsToReenter(sesSaved, { ...sBase, accessKeyId: "AKIAOTHERKEY00000000", configurationSet: "axs-events", fromName: "B" })).toEqual([]);
    expect(secretsToReenter(sesSaved, { ...sBase, region: "eu-west-1" })).toEqual(["secretAccessKey"]);
    expect(clientErrors(sesSaved, { ...sBase, region: "eu-west-1" }, 4)).toEqual({ secretAccessKey: "Enter it again: the email provider, server or region changed." });
    // SES back to SMTP with a username: the password is required (nothing saved for it).
    expect(clientErrors(sesSaved, { ...sBase, provider: "smtp", username: "mailer" }, 4)).toEqual({ password: "Enter the password." });
  });

  it("says before Save that switching provider deletes the other provider's saved secret", () => {
    const smtpSaved = email(SET, UNSET, "smtp");
    const base = toDraft(smtpSaved);
    expect(secretsRemovedBySave(smtpSaved, base)).toEqual([]);
    expect(providerSwitchNote(smtpSaved, base)).toBeNull();
    expect(providerSwitchNote(smtpSaved, { ...base, fromName: "Axiomatic Software" })).toBeNull();
    expect(secretsRemovedBySave(smtpSaved, { ...base, provider: "ses" })).toEqual(["password"]);
    expect(providerSwitchNote(smtpSaved, { ...base, provider: "ses" })).toBe("Saving removes the saved password.");
    const sesSaved = email(UNSET, SET, "ses");
    expect(providerSwitchNote(sesSaved, { ...toDraft(sesSaved), provider: "smtp" })).toBe("Saving removes the saved secret access key.");
    // Nothing saved for the provider being left: nothing to warn about.
    expect(providerSwitchNote(email(UNSET, UNSET, "smtp"), { ...toDraft(email()), provider: "ses" })).toBeNull();
    // Payments and storage never switch provider.
    expect(providerSwitchNote(storage(SET), toDraft(storage(SET)))).toBeNull();
    expect(providerSwitchNote(payments({ keySecret: SET, webhookSecret: SET }), toDraft(payments()))).toBeNull();
  });

  it("does not claim the server file holds the secret of a provider the Owner switched to", () => {
    // EMAIL_TRANSPORT=smtp in the server file, the form switched to Amazon SES.
    const envSmtp: IntegrationForm = { ...email(UNSET, UNSET, "smtp"), prefilledFrom: "env" };
    const baseline = toDraft(envSmtp);
    const toSes = { ...baseline, provider: "ses" };
    expect(secretHintSource("env", "email", baseline, baseline)).toBe("env");
    expect(secretHintSource("env", "email", baseline, toSes)).toBe("none");
    expect(secretInputHint({ kind: "email", replacing: false, source: secretHintSource("env", "email", baseline, toSes), saved: false, unused: false })).toBeNull();
    expect(secretInputHint({ kind: "email", replacing: false, source: secretHintSource("env", "email", baseline, baseline), saved: false, unused: false })).toBe(
      "In the server file. Enter it here to save these settings in Admin.",
    );
    // Other integrations keep their source.
    expect(secretHintSource("env", "storage", toDraft(storage()), toDraft(storage()))).toBe("env");
  });
});

describe("presets and linked fields", () => {
  it("prefill endpoint, region and path style per provider; Other changes nothing", () => {
    const d = toDraft(storage());
    expect(applyPreset(d, "aws")).toMatchObject({ preset: "aws", endpoint: "", region: "ap-south-1", forcePathStyle: false });
    expect(applyPreset(d, "r2")).toMatchObject({ preset: "r2", endpoint: "", region: "auto", forcePathStyle: true });
    expect(applyPreset(d, "spaces")).toMatchObject({ preset: "spaces", endpoint: "https://blr1.digitaloceanspaces.com", region: "blr1", forcePathStyle: false });
    expect(applyPreset(d, "other")).toEqual({ ...d, preset: "other" });
    expect(presetHint("r2")).toBe("Filled in for Cloudflare R2. Check the values.");
    expect(presetHint("other")).toBeNull();
  });

  it("lets the Spaces endpoint follow its region until the Owner edits it", () => {
    const spaces = applyPreset(toDraft(storage()), "spaces");
    expect(applyRegion(spaces, "sgp1")).toMatchObject({ region: "sgp1", endpoint: "https://sgp1.digitaloceanspaces.com" });
    expect(applyRegion({ ...spaces, endpoint: "https://cdn.example.com" }, "sgp1").endpoint).toBe("https://cdn.example.com");
    expect(applyRegion(toDraft(storage()), "weur").endpoint).toBe("https://acc123.r2.cloudflarestorage.com");
  });

  it("switches the SMTP port with the security setting only while it holds the other default", () => {
    const d = toDraft(email());
    expect(applySecurity(d, "tls")).toMatchObject({ security: "tls", port: "465" });
    expect(applySecurity(applySecurity(d, "tls"), "starttls")).toMatchObject({ security: "starttls", port: "587" });
    expect(applySecurity({ ...d, port: "2525" }, "tls")).toMatchObject({ security: "tls", port: "2525" });
  });
});

describe("card state", () => {
  it("labels the source, development drivers and mode in text, and says who saved it", () => {
    expect(integrationBadges({ source: "admin", development: false, mode: "live" })).toEqual([
      { label: "Saved in Admin", tone: "sage" },
      { label: "Live mode", tone: "sage" },
    ]);
    expect(integrationBadges({ source: "env", development: true, mode: "test" }).map((b) => b.label)).toEqual(["From the server file", "Development only", "Test mode"]);
    expect(integrationBadges({ source: "none", development: false, mode: null })).toEqual([{ label: "Not configured", tone: "pink" }]);
    expect(cardNote({ saved: { revision: 2, updatedAt: "2026-10-08T08:30:00.000Z", updatedBy: "Asha Rao" }, source: "admin" })).toBe("Saved by Asha Rao on 8 Oct 2026");
    expect(cardNote({ saved: null, source: "env" })).toBe("Using the server file. Save here to replace it.");
    expect(cardNote({ saved: null, source: "none" })).toBe("Nothing saved yet.");
  });

  it("enables the test button only for a configured integration without unsaved changes", () => {
    expect(testButtonState({ source: "none" }, false)).toEqual({ enabled: false, hint: "Save the settings first." });
    expect(testButtonState({ source: "admin" }, true)).toEqual({ enabled: false, hint: "Save your changes first." });
    expect(testButtonState({ source: "env" }, false)).toEqual({ enabled: true, hint: null });
  });

  it("describes a saved secret by its last 4 characters (long secrets only), never its value", () => {
    expect(secretSummary(SET)).toEqual({ summary: "Set (ends 1a2b)", changed: "Changed by Asha Rao on 8 Oct 2026" });
    expect(secretSummary({ ...SET, last4: null, updatedBy: null })).toEqual({ summary: "Set", changed: "Changed on 8 Oct 2026" });
    expect(secretInputHint({ kind: "email", replacing: true, source: "admin", saved: true, unused: false })).toBe("Leave empty to keep the saved value.");
    expect(secretInputHint({ kind: "email", replacing: false, source: "env", saved: false, unused: false })).toBe("In the server file. Enter it here to save these settings in Admin.");
    expect(secretInputHint({ kind: "email", replacing: false, source: "none", saved: false, unused: false })).toBeNull();
    expect(secretInputHint({ kind: "email", replacing: false, source: "admin", saved: true, unused: true })).toBe("Not used without a username.");
  });
});

describe("status-only cards", () => {
  const panel = readFileSync("components/admin/settings/integrations-panel.tsx", "utf8");
  const statusCard = panel.slice(panel.indexOf("export function IntegrationStatusCard("), panel.indexOf("export function RedisCard("));

  it("show provider, source and mode only", () => {
    expect(statusFacts({ provider: "Razorpay", source: "env", mode: "live" })).toEqual([
      { label: "Provider", value: "Razorpay" },
      { label: "Source", value: "From the server file" },
      { label: "Mode", value: "Live mode" },
    ]);
    expect(statusFacts({ provider: "Not set", source: "none", mode: null })).toHaveLength(2);
  });

  it("render no inputs, no secret hints and no form values (source check of the .tsx)", () => {
    expect(statusCard.length).toBeGreaterThan(100);
    for (const forbidden of ["<Input", "<SecretField", "<NativeSelect", "<Switch", ".form", ".secrets", "ends", "last4"]) {
      expect(statusCard.includes(forbidden), forbidden).toBe(false);
    }
    expect(statusCard).toContain("READ_ONLY_FOR_ROLE");
    // Forms only for integrations.manage, and only when the server sent one.
    expect(panel).toContain("data.canManage && item.form ?");
  });

  it("keep secret inputs write-only and the password confirmation a current-password field", () => {
    const secret = readFileSync("components/admin/settings/secret-field.tsx", "utf8");
    expect(secret).toContain('type="password"');
    // Chrome ignores autocomplete="off" on password inputs and filled the Owner's saved sign-in there (2026-10-08):
    // "new-password" is never filled with a saved password; the ignore attributes cover the password managers.
    expect(secret).toContain('autoComplete="new-password"');
    expect(secret).not.toContain('autoComplete="off"');
    expect(secret).toContain("name={name}");
    for (const attr of ['data-1p-ignore=""', 'data-lpignore="true"', 'data-bwignore=""', 'data-form-type="other"']) expect(secret).toContain(attr);
    const card = readFileSync("components/admin/settings/integration-card.tsx", "utf8");
    expect(card).toContain('autoComplete="off"');
    expect(card).toContain("{...NO_PASSWORD_MANAGER}");
    for (const attr of ['"data-1p-ignore": ""', '"data-lpignore": "true"', '"data-bwignore": ""', '"data-form-type": "other"']) expect(card).toContain(attr);
    expect(secret).toContain("spellCheck={false}");
    expect(secret).not.toMatch(/defaultValue|last4\}/);
    const dialog = readFileSync("components/admin/settings/password-dialog.tsx", "utf8");
    expect(dialog).toContain('autoComplete="current-password"');
    expect(dialog).toContain("aria-describedby={fieldError ? errorId : undefined}");
  });
});
