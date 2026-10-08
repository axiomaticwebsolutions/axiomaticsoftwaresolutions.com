/**
 * The client-safe integration model (lib/integrations/model.ts) and sender parsing (lib/email/address.ts): save-body
 * and persisted-settings schemas (email: SMTP or Amazon SES), presets, Razorpay mode, the secrets each provider uses
 * and the re-entry rule.
 */
import { describe, expect, it } from "vitest";
import { formatMailbox, parseMailbox } from "@/lib/email/address";
import {
  applicableSecrets,
  DEFAULT_SES_REGION,
  destinationChanged,
  emailSaveSchema,
  emailSettingsSchema,
  fieldLabel,
  fromDbKind,
  guessStoragePreset,
  INTEGRATION_KINDS,
  isIntegrationKind,
  isSecretField,
  normalizeEndpoint,
  passwordConfirmSchema,
  paymentsSaveSchema,
  paymentsSettingsSchema,
  probeBodySchema,
  razorpayMode,
  requiredSecrets,
  secretProblem,
  SES_REGION_IDS,
  sesSaveSchema,
  smtpSaveSchema,
  splitSaveBody,
  storageSaveSchema,
  storageSettingsSchema,
  toDbKind,
} from "@/lib/integrations/model";

const issues = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  r.success ? {} : Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join("."), i.message]));

const payments = { currentPassword: "owner-password", revision: null, keyId: "rzp_test_1DP5mmOlF5G5ag" };
const email = {
  currentPassword: "pw",
  revision: 3,
  host: "smtp.example.com",
  port: 587,
  security: "starttls",
  username: "mailer",
  fromName: "Axiomatic Software",
  fromAddress: "no-reply@axiomatic.example",
};
const storage = {
  currentPassword: "pw",
  revision: null,
  preset: "r2",
  endpoint: "https://acc123.r2.cloudflarestorage.com/",
  region: "auto",
  bucket: "axs-files",
  accessKeyId: "a1b2c3d4e5f6",
  forcePathStyle: true,
};

describe("kinds, fields and modes", () => {
  it("maps kinds to the database enum and back, and knows each kind's secret fields", () => {
    expect(INTEGRATION_KINDS.map(toDbKind)).toEqual(["PAYMENTS", "EMAIL", "STORAGE"]);
    expect(INTEGRATION_KINDS.map((k) => fromDbKind(toDbKind(k)))).toEqual([...INTEGRATION_KINDS]);
    expect(isIntegrationKind("payments")).toBe(true);
    expect(isIntegrationKind("perm-test-0000")).toBe(false);
    expect(isSecretField("payments", "webhookSecret")).toBe(true);
    expect(isSecretField("payments", "password")).toBe(false);
    expect(isSecretField("storage", "secretAccessKey")).toBe(true);
    expect(isSecretField("email", "password")).toBe(true);
    expect(isSecretField("email", "secretAccessKey")).toBe(true);
    expect(isSecretField("email", "keySecret")).toBe(false);
    expect(fieldLabel("email", "region")).toBe("AWS region");
    expect(fieldLabel("payments", "keySecret")).toBe("Key secret");
    expect(fieldLabel("storage", "forcePathStyle")).toBe("Path-style URLs");
  });

  it("derives the payment mode from the Key ID prefix", () => {
    expect(razorpayMode("rzp_test_1DP5mmOlF5G5ag")).toBe("test");
    expect(razorpayMode("rzp_live_AbCdEf123456")).toBe("live");
    for (const bad of ["rzp_test_pending", "rzp_test_", "rzp_prod_AbCdEf123456", "mock_key", ""]) expect(razorpayMode(bad), bad).toBeNull();
  });

  it("needs the SMTP password only with a username, and the SES secret access key always", () => {
    expect(requiredSecrets("payments", { provider: "razorpay", keyId: "rzp_test_1DP5mmOlF5G5ag" })).toEqual(["keySecret", "webhookSecret"]);
    const base = { provider: "smtp", host: "smtp.example.com", port: 587, security: "starttls", fromName: "A", fromAddress: "a@b.co" } as const;
    expect(requiredSecrets("email", { ...base, username: null })).toEqual([]);
    expect(requiredSecrets("email", { ...base, username: "u" })).toEqual(["password"]);
    const ses = { provider: "ses", region: "ap-south-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", configurationSet: null, fromName: "A", fromAddress: "a@b.co" } as const;
    expect(requiredSecrets("email", ses)).toEqual(["secretAccessKey"]);
    // The secrets a provider can use: the other provider's saved secret is never opened or sent.
    expect(applicableSecrets("email", base)).toEqual(["password"]);
    expect(applicableSecrets("email", { host: "smtp.example.com" })).toEqual(["password"]); // rows saved before SES
    expect(applicableSecrets("email", ses)).toEqual(["secretAccessKey"]);
    expect(applicableSecrets("payments", {})).toEqual(["keySecret", "webhookSecret"]);
  });

  it("re-entry rule: a new provider, SMTP server or SES region moves the secrets; the sender or the key ID does not", () => {
    const smtp = { provider: "smtp", host: "smtp.example.com", port: 587, security: "starttls" };
    const ses = { provider: "ses", region: "ap-south-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE" };
    expect(destinationChanged("email", smtp, { ...smtp, fromName: "B" })).toBe(false);
    expect(destinationChanged("email", { ...smtp, provider: undefined }, smtp)).toBe(false); // no provider = SMTP
    expect(destinationChanged("email", smtp, { ...smtp, host: "SMTP.Example.com" })).toBe(false);
    expect(destinationChanged("email", smtp, { ...smtp, host: "smtp.other.example" })).toBe(true);
    expect(destinationChanged("email", smtp, ses)).toBe(true);
    expect(destinationChanged("email", ses, smtp)).toBe(true);
    expect(destinationChanged("email", ses, { ...ses, accessKeyId: "AKIAOTHERKEY00000000", configurationSet: "events" })).toBe(false);
    expect(destinationChanged("email", ses, { ...ses, region: "eu-west-1" })).toBe(true);
    // An SES draft still carries SMTP defaults (and the reverse): only the chosen provider's fields count.
    expect(destinationChanged("email", ses, { ...ses, host: "smtp.other.example", port: 2525 })).toBe(false);
    expect(destinationChanged("email", smtp, { ...smtp, region: "eu-west-1" })).toBe(false);
  });
});

describe("save bodies", () => {
  it("payments: Key ID format, optional secrets (empty keeps the stored one), strict object", () => {
    expect(paymentsSaveSchema.parse({ ...payments, keySecret: "", webhookSecret: "  " })).toEqual({ ...payments, keySecret: undefined, webhookSecret: undefined });
    expect(paymentsSaveSchema.parse({ ...payments, keySecret: "  secret-123  " }).keySecret).toBe("secret-123");
    expect(issues(paymentsSaveSchema.safeParse({ ...payments, keyId: "rzp_test_pending" }))).toEqual({
      keyId: "Enter a Key ID that starts with rzp_test_ or rzp_live_.",
    });
    expect(issues(paymentsSaveSchema.safeParse({ ...payments, webhookSecret: "short" }))).toEqual({ webhookSecret: "Enter at least 16 characters." });
    expect(issues(paymentsSaveSchema.safeParse({ ...payments, keySecret: "change-me-please" }))).toEqual({
      keySecret: "This looks like a placeholder. Enter the real value.",
    });
    expect(issues(paymentsSaveSchema.safeParse({ ...payments, keySecret: "line\nbreak-secret" }))).toEqual({
      keySecret: "Remove line breaks and other control characters.",
    });
    expect(paymentsSaveSchema.safeParse({ ...payments, extra: 1 }).success).toBe(false);
    expect(issues(paymentsSaveSchema.safeParse({ ...payments, currentPassword: "" }))).toEqual({ currentPassword: "Enter your password." });
  });

  it("email: host, port, security, From address; an empty username means none", () => {
    const parsed = emailSaveSchema.parse({ ...email, host: " SMTP.Example.com. ", username: "" });
    // A body without a provider is an SMTP body (clients written before Amazon SES).
    expect(parsed).toMatchObject({ provider: "smtp", host: "smtp.example.com", username: null });
    expect((parsed as { password?: string }).password).toBeUndefined();
    expect(emailSaveSchema.parse({ ...email, provider: "smtp" })).toMatchObject({ provider: "smtp", host: "smtp.example.com" });
    expect(issues(emailSaveSchema.safeParse({ ...email, port: 70_000 }))).toEqual({ port: "Enter a port from 1 to 65535." });
    expect(issues(emailSaveSchema.safeParse({ ...email, port: "587" }))).toEqual({ port: "Enter a port from 1 to 65535." });
    expect(issues(emailSaveSchema.safeParse({ ...email, security: "ssl" }))).toEqual({ security: "Choose STARTTLS or TLS." });
    expect(issues(emailSaveSchema.safeParse({ ...email, host: "smtp host" }))).toEqual({ host: "Enter a host name such as smtp.example.com." });
    expect(issues(emailSaveSchema.safeParse({ ...email, fromAddress: "no-reply" }))).toEqual({
      fromAddress: "Enter an email address such as no-reply@example.com.",
    });
    expect(issues(emailSaveSchema.safeParse({ ...email, fromName: "Evil <x@y.z>" }))).toEqual({
      fromName: "Use letters, digits and spaces only (no < or >).",
    });
    expect((emailSaveSchema.parse({ ...email, password: "p" }) as { password?: string }).password).toBe("p");
    expect(issues(emailSaveSchema.safeParse({ ...email, provider: "sendgrid" }))).toEqual({ provider: "Choose SMTP or Amazon SES." });
    // An SMTP body cannot carry SES fields (strict per provider).
    expect(issues(emailSaveSchema.safeParse({ ...email, region: "ap-south-1" }))).toEqual({ "": 'Unrecognized key: "region"' });
  });

  it("email (Amazon SES): region from the SES list, AWS key ID, optional configuration set, the same From rules", () => {
    const ses = {
      currentPassword: "pw",
      revision: null,
      provider: "ses",
      region: " AP-SOUTH-1 ",
      accessKeyId: " AKIAIOSFODNN7EXAMPLE ",
      secretAccessKey: "  wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEY  ",
      configurationSet: "",
      fromName: "Axiomatic Software",
      fromAddress: "no-reply@axiomatic.example",
    };
    expect(emailSaveSchema.parse(ses)).toEqual({
      ...ses,
      region: "ap-south-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEY",
      configurationSet: null,
    });
    expect(emailSaveSchema.parse({ ...ses, configurationSet: undefined, secretAccessKey: "" })).toMatchObject({ configurationSet: null, secretAccessKey: undefined });
    expect(emailSaveSchema.parse({ ...ses, configurationSet: "axs-events_1" })).toMatchObject({ configurationSet: "axs-events_1" });
    expect(SES_REGION_IDS).toContain(DEFAULT_SES_REGION);
    expect(issues(emailSaveSchema.safeParse({ ...ses, region: "ap-south-9" }))).toEqual({ region: "Choose a region where Amazon SES is available." });
    expect(issues(emailSaveSchema.safeParse({ ...ses, region: "auto" }))).toEqual({ region: "Choose a region where Amazon SES is available." });
    expect(issues(emailSaveSchema.safeParse({ ...ses, accessKeyId: "akia-lower" }))).toEqual({
      accessKeyId: "Enter the access key ID: capital letters and digits, usually starting with AKIA.",
    });
    expect(issues(emailSaveSchema.safeParse({ ...ses, accessKeyId: "XXXXXXXXXXXXXXXXXXXX" }))).toEqual({ accessKeyId: "Enter the real access key ID." });
    expect(issues(emailSaveSchema.safeParse({ ...ses, secretAccessKey: "short" }))).toEqual({ secretAccessKey: "Enter at least 8 characters." });
    expect(issues(emailSaveSchema.safeParse({ ...ses, configurationSet: "bad set!" }))).toEqual({
      configurationSet: "Use letters, digits, hyphens and underscores only (up to 64), or leave it empty.",
    });
    expect(issues(emailSaveSchema.safeParse({ ...ses, fromAddress: "no-reply" }))).toEqual({ fromAddress: "Enter an email address such as no-reply@example.com." });
    expect(issues(emailSaveSchema.safeParse({ ...ses, fromName: "Evil <x@y.z>" }))).toEqual({ fromName: "Use letters, digits and spaces only (no < or >)." });
    // No endpoint, host or SMTP password on an SES body.
    for (const extra of [{ endpoint: "https://ses.example.com" }, { host: "smtp.example.com" }, { password: "p" }]) {
      expect(emailSaveSchema.safeParse({ ...ses, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    expect(Object.keys(sesSaveSchema.shape)).not.toContain("endpoint");
    expect(Object.keys(smtpSaveSchema.shape)).toContain("host");
  });

  it("storage: endpoint normalised to its origin and required except for AWS; bucket and region rules", () => {
    const parsed = storageSaveSchema.parse(storage);
    expect(parsed.endpoint).toBe("https://acc123.r2.cloudflarestorage.com");
    expect(parsed.secretAccessKey).toBeUndefined();
    expect(storageSaveSchema.parse({ ...storage, preset: "aws", endpoint: "", region: "ap-south-1" }).endpoint).toBeNull();
    expect(issues(storageSaveSchema.safeParse({ ...storage, endpoint: "" }))).toEqual({ endpoint: "Enter the endpoint." });
    expect(issues(storageSaveSchema.safeParse({ ...storage, endpoint: "https://acc123.r2.cloudflarestorage.com/axs-files" }))).toEqual({
      endpoint: "Enter an https:// address without a path, such as https://s3.ap-south-1.amazonaws.com.",
    });
    expect(issues(storageSaveSchema.safeParse({ ...storage, bucket: "Axs_Files" }))).toHaveProperty("bucket");
    expect(issues(storageSaveSchema.safeParse({ ...storage, region: "ap south" }))).toHaveProperty("region");
    expect(issues(storageSaveSchema.safeParse({ ...storage, accessKeyId: "xxxxxxxx" }))).toEqual({ accessKeyId: "Enter the real access key ID." });
    expect(issues(storageSaveSchema.safeParse({ ...storage, secretAccessKey: "CHANGE-ME-123" }))).toEqual({
      secretAccessKey: "This looks like a placeholder. Enter the real value.",
    });
    expect(storageSaveSchema.safeParse({ ...storage, forcePathStyle: "true" }).success).toBe(false);
  });

  it("splits a body into persisted settings and the secrets that were entered", () => {
    expect(splitSaveBody("payments", paymentsSaveSchema.parse({ ...payments, webhookSecret: "whsec_0123456789abcdef" }))).toEqual({
      settings: { provider: "razorpay", keyId: payments.keyId },
      secrets: { webhookSecret: "whsec_0123456789abcdef" },
    });
    expect(splitSaveBody("email", emailSaveSchema.parse({ ...email, password: "smtp-pass" }))).toEqual({
      settings: { provider: "smtp", host: "smtp.example.com", port: 587, security: "starttls", username: "mailer", fromName: "Axiomatic Software", fromAddress: "no-reply@axiomatic.example" },
      secrets: { password: "smtp-pass" },
    });
    const sesBody = { currentPassword: "pw", revision: 1, provider: "ses", region: "ap-south-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "ses-secret-key-0001", fromName: "A", fromAddress: "a@b.co" };
    const sesSplit = splitSaveBody("email", emailSaveSchema.parse(sesBody));
    expect(sesSplit).toEqual({
      settings: { provider: "ses", region: "ap-south-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", configurationSet: null, fromName: "A", fromAddress: "a@b.co" },
      secrets: { secretAccessKey: "ses-secret-key-0001" },
    });
    expect(emailSettingsSchema.parse(sesSplit.settings)).toEqual(sesSplit.settings);
    const split = splitSaveBody("storage", storageSaveSchema.parse({ ...storage, secretAccessKey: "s3cr3t-key-value" }));
    expect(split.secrets).toEqual({ secretAccessKey: "s3cr3t-key-value" });
    expect(storageSettingsSchema.parse(split.settings)).toEqual(split.settings);
    expect(split.settings).not.toHaveProperty("currentPassword");
  });

  it("DELETE and test bodies are strict", () => {
    expect(passwordConfirmSchema.safeParse({ currentPassword: "pw" }).success).toBe(true);
    expect(passwordConfirmSchema.safeParse({ currentPassword: "pw", force: true }).success).toBe(false);
    expect(probeBodySchema.safeParse({}).success).toBe(true);
    expect(probeBodySchema.safeParse({ to: "someone@example.com" }).success).toBe(false);
  });
});

describe("persisted settings", () => {
  it("refuses extra keys and values that would not pass the save rules", () => {
    expect(paymentsSettingsSchema.safeParse({ provider: "razorpay", keyId: "rzp_live_AbCdEf123456" }).success).toBe(true);
    expect(paymentsSettingsSchema.safeParse({ provider: "razorpay", keyId: "rzp_live_AbCdEf123456", keySecret: "x" }).success).toBe(false);
    expect(paymentsSettingsSchema.safeParse({ provider: "mock", keyId: "mock_key" }).success).toBe(false);
    const e = { host: "smtp.example.com", port: 465, security: "tls", username: null, fromName: "A", fromAddress: "a@b.co" };
    // Rows saved before Amazon SES have no provider: they read as SMTP.
    expect(emailSettingsSchema.parse(e)).toEqual({ provider: "smtp", ...e });
    expect(emailSettingsSchema.safeParse({ ...e, provider: "smtp" }).success).toBe(true);
    expect(emailSettingsSchema.safeParse({ ...e, host: "SMTP.example.com" }).success).toBe(false);
    const s = { provider: "ses", region: "ap-south-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", configurationSet: null, fromName: "A", fromAddress: "a@b.co" };
    expect(emailSettingsSchema.safeParse(s).success).toBe(true);
    for (const bad of [{ region: "mars-1" }, { accessKeyId: "short" }, { configurationSet: "bad set" }, { endpoint: "https://x.example" }, { provider: "mailgun" }]) {
      expect(emailSettingsSchema.safeParse({ ...s, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    const st = { preset: "aws", endpoint: null, region: "ap-south-1", bucket: "axs-files", accessKeyId: "AKIAEXAMPLE", forcePathStyle: false };
    expect(storageSettingsSchema.safeParse(st).success).toBe(true);
    expect(storageSettingsSchema.safeParse({ ...st, endpoint: "https://files.example.com/x" }).success).toBe(false);
  });
});

describe("helpers", () => {
  it("normalises endpoints to an origin and guesses presets", () => {
    expect(normalizeEndpoint("https://S3.AP-SOUTH-1.amazonaws.com/")).toBe("https://s3.ap-south-1.amazonaws.com");
    for (const bad of ["", "s3.amazonaws.com", "https://u:p@x.com", "https://x.com/p", "https://x.com/?q", "https://*.r2.cloudflarestorage.com"]) {
      expect(normalizeEndpoint(bad), bad).toBeNull();
    }
    expect(guessStoragePreset(null)).toBe("aws");
    expect(guessStoragePreset("https://acc.r2.cloudflarestorage.com")).toBe("r2");
    expect(guessStoragePreset("https://blr1.digitaloceanspaces.com")).toBe("spaces");
    expect(guessStoragePreset("https://minio.example.com")).toBe("other");
  });

  it("checks secret values (length, control characters, placeholders)", () => {
    expect(secretProblem("password", "x")).toBeNull();
    expect(secretProblem("password", "  ")).toBe("Enter the password.");
    expect(secretProblem("secretAccessKey", "1234567")).toBe("Enter at least 8 characters.");
    expect(secretProblem("keySecret", "a".repeat(513))).toBe("Use at most 512 characters.");
    expect(secretProblem("keySecret", "xxxxxxxxxx")).toBe("This looks like a placeholder. Enter the real value.");
  });

  it("parses senders as { name, address }", () => {
    expect(parseMailbox("Axiomatic Software <no-reply@Axiomatic.Example>")).toEqual({ name: "Axiomatic Software", address: "no-reply@axiomatic.example" });
    expect(parseMailbox('"Axiomatic, Billing" <billing@axiomatic.example>')).toEqual({ name: "Axiomatic, Billing", address: "billing@axiomatic.example" });
    expect(parseMailbox("no-reply@localhost")).toEqual({ name: "", address: "no-reply@localhost" });
    for (const bad of ["", "Name <>", "Name <not an address>", "a@b.co\nBcc: x@y.z", "<a@b.co> trailing", "Na<me <a@b.co>"]) {
      expect(parseMailbox(bad), bad).toBeNull();
    }
    expect(formatMailbox({ name: "A", address: "a@b.co" })).toBe("A <a@b.co>");
  });
});
