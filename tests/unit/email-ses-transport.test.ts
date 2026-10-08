/**
 * Amazon SES as an email provider (lib/email/transports/ses.ts, lib/email/transport.ts; docs/admin-integrations-design.md
 * section 25): transport selection SMTP vs SES with a mocked SESv2 client, the client options (region and keys only, no
 * endpoint), the raw MIME message built by nodemailer exactly as for SMTP, the configuration set, close(), and the
 * process-wide transport rebuilt when the effective configuration changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmailTransport, getEmailTransport, sendErrorSummary, setEmailTransport, type OutgoingEmail } from "@/lib/email/transport";
import { createSesTransport, sesClientConfig, type SesConfig } from "@/lib/email/transports/ses";
import { invalidateIntegrations, setIntegrationEnvForTests } from "@/lib/integrations/resolver";
import type { EmailConfig } from "@/lib/integrations/types";

const aws = vi.hoisted(() => {
  const clients: { config: Record<string, unknown>; sent: unknown[]; destroyed: number }[] = [];
  const state: { failWith: unknown } = { failWith: null };
  class SendEmailCommand {
    readonly input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  class SESv2Client {
    readonly record: { config: Record<string, unknown>; sent: unknown[]; destroyed: number };
    readonly config: { region: () => Promise<string> };
    constructor(config: Record<string, unknown>) {
      this.record = { config, sent: [], destroyed: 0 };
      this.config = { region: async () => String(config.region) };
      clients.push(this.record);
    }
    async send(command: SendEmailCommand) {
      this.record.sent.push(command.input);
      if (state.failWith) throw state.failWith;
      return { MessageId: `0109019a-${this.record.sent.length}` };
    }
    destroy() {
      this.record.destroyed += 1;
    }
  }
  return { clients, state, SendEmailCommand, SESv2Client };
});

vi.mock("@aws-sdk/client-sesv2", () => ({ SESv2Client: aws.SESv2Client, SendEmailCommand: aws.SendEmailCommand }));

const FROM = { name: "Axiomatic Software", address: "no-reply@axiomatic.example" };
const SES: SesConfig = {
  transport: "ses",
  region: "ap-south-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "ses-secret-access-key-01",
  configurationSet: null,
  from: FROM,
};
const SMTP: EmailConfig = { transport: "smtp", host: "smtp.example.com", port: 587, security: "starttls", auth: null, from: FROM };
const MESSAGE: OutgoingEmail = {
  to: "priya@sharmamedicals.example",
  subject: "Your invoice INV-2026-0001",
  html: "<p>Thank you for your order.</p>",
  text: "Thank you for your order.",
  templateId: "order_paid",
};

const rawOf = (input: unknown) => Buffer.from((input as { Content: { Raw: { Data: Buffer } } }).Content.Raw.Data).toString("utf8");

beforeEach(() => {
  aws.clients.length = 0;
  aws.state.failWith = null;
});
afterEach(() => {
  setEmailTransport(null);
  setIntegrationEnvForTests(null);
});

describe("transport selection", () => {
  it("builds an SES transport for transport ses and an SMTP one for smtp (no SES client then)", async () => {
    const smtp = await createEmailTransport(SMTP, { pool: false });
    expect(smtp.name).toBe("smtp");
    smtp.close?.();
    expect(aws.clients).toHaveLength(0);
    const ses = await createEmailTransport(SES, { pool: false });
    expect(ses.name).toBe("ses");
    expect(aws.clients).toHaveLength(1);
  });

  it("gives the SESv2 client the region and keys only: never an endpoint, standard retries and timeouts", async () => {
    const options = sesClientConfig(SES) as Record<string, unknown>;
    expect(options).toMatchObject({
      region: "ap-south-1",
      credentials: { accessKeyId: SES.accessKeyId, secretAccessKey: SES.secretAccessKey },
      // AWS_ENDPOINT_URL / AWS_ENDPOINT_URL_SESV2 / endpoint_url and the FIPS / dual-stack switches cannot move it.
      ignoreConfiguredEndpointUrls: true,
      useFipsEndpoint: false,
      useDualstackEndpoint: false,
      maxAttempts: 3,
      requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000, throwOnRequestTimeout: true },
    });
    expect(options).not.toHaveProperty("endpoint");
    await createEmailTransport({ ...SES, region: "eu-west-1" });
    expect(aws.clients[0]?.config).toMatchObject({ region: "eu-west-1", ignoreConfiguredEndpointUrls: true });
    expect(aws.clients[0]?.config).not.toHaveProperty("endpoint");
  });
});

describe("sending through SES", () => {
  it("sends the raw MIME message nodemailer builds for SMTP too (From, To, both parts, headers)", async () => {
    const transport = await createEmailTransport(SES);
    const result = await transport.send(MESSAGE);
    expect(result.messageId).toBe("<0109019a-1@ap-south-1.amazonses.com>");
    const [input] = aws.clients[0]?.sent ?? [];
    expect(input).toMatchObject({ Destination: { ToAddresses: [MESSAGE.to] } });
    expect(String((input as { FromEmailAddress?: unknown }).FromEmailAddress)).toContain("no-reply@axiomatic.example");
    expect(input).not.toHaveProperty("ConfigurationSetName");
    const raw = rawOf(input);
    expect(raw).toMatch(/^From: Axiomatic Software <no-reply@axiomatic\.example>\r$/m);
    expect(raw).toMatch(/^To: priya@sharmamedicals\.example\r$/m);
    expect(raw).toMatch(/^Subject: Your invoice INV-2026-0001\r$/m);
    expect(raw).toMatch(/^Auto-Submitted: auto-generated\r$/m);
    expect(raw).toMatch(/^X-Axs-Template: order_paid\r$/m);
    expect(raw).toContain("Content-Type: text/plain");
    expect(raw).toContain("Content-Type: text/html");
    expect(raw).toContain("<p>Thank you for your order.</p>");
    // The secret never travels in the message.
    expect(JSON.stringify(input)).not.toContain(SES.secretAccessKey);
  });

  it("adds the configuration set when one is saved, and close() releases the client", async () => {
    const transport = createSesTransport({ ...SES, configurationSet: "axs-events" });
    await transport.send(MESSAGE);
    expect(aws.clients[0]?.sent[0]).toMatchObject({ ConfigurationSetName: "axs-events" });
    transport.close?.();
    expect(aws.clients[0]?.destroyed).toBe(1);
  });

  it("rejects with the AWS error (name kept, code ESES from nodemailer); logs carry codes only", async () => {
    const rejected = new Error("Email address is not verified. The following identities failed: priya@sharmamedicals.example");
    aws.state.failWith = Object.assign(rejected, { name: "MessageRejected", $metadata: { httpStatusCode: 400 } });
    const transport = createSesTransport(SES);
    const error = await transport.send(MESSAGE).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ name: "MessageRejected", code: "ESES" });
    const summary = sendErrorSummary(error);
    expect(summary).toEqual({ name: "MessageRejected", errorCode: "ESES", httpStatus: 400 });
    expect(JSON.stringify(summary)).not.toContain("priya");
  });
});

describe("the process-wide transport", () => {
  const ENV = {
    NODE_ENV: "test",
    EMAIL_TRANSPORT: "ses",
    EMAIL_FROM: "Axiomatic <no-reply@axiomatic.example>",
    SES_REGION: "ap-south-1",
    SES_ACCESS_KEY_ID: SES.accessKeyId,
    SES_SECRET_ACCESS_KEY: SES.secretAccessKey,
  };

  it("follows the effective configuration: one SES client while it holds, a new transport when it changes", async () => {
    setIntegrationEnvForTests(ENV);
    const first = await getEmailTransport();
    expect(first.name).toBe("ses");
    expect(await getEmailTransport()).toBe(first);
    expect(aws.clients).toHaveLength(1);
    setIntegrationEnvForTests({ ...ENV, SES_REGION: "eu-west-1" });
    const second = await getEmailTransport();
    expect(second).not.toBe(first);
    expect(aws.clients.map((c) => c.config.region)).toEqual(["ap-south-1", "eu-west-1"]);
    setIntegrationEnvForTests({ NODE_ENV: "test", EMAIL_TRANSPORT: "smtp", EMAIL_FROM: ENV.EMAIL_FROM, SMTP_HOST: "localhost", SMTP_PORT: "1025" });
    expect((await getEmailTransport()).name).toBe("smtp");
    invalidateIntegrations();
  });
});
