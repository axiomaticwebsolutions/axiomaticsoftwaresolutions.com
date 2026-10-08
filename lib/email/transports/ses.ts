/**
 * Amazon SES transport (API, not SMTP): nodemailer's SES transport with the AWS SDK v3 SESv2 client
 * (@aws-sdk/client-sesv2, pinned to the @aws-sdk/client-s3 version). nodemailer builds the MIME message exactly as for
 * SMTP (./mail-options.ts: From, HTML and text, headers, any attachment) and hands it to SESv2 SendEmail as
 * Content.Raw, with the SES configuration set when one is saved.
 *
 * The client gets the region and the access key only: no endpoint, so it always talks to AWS's own endpoint for a
 * region from model.ts SES_REGIONS (email.<region>.amazonaws.com) and an Owner cannot point the secret anywhere else;
 * there is no SSRF surface to guard (the SMTP transport keeps its guard). The server environment cannot move it either:
 * ignoreConfiguredEndpointUrls makes the SDK skip AWS_ENDPOINT_URL, AWS_ENDPOINT_URL_SESV2 and endpoint_url in
 * ~/.aws/config, and FIPS / dual-stack are pinned off (AWS_USE_FIPS_ENDPOINT, AWS_USE_DUALSTACK_ENDPOINT are ignored).
 * Explicit credentials mean the SDK never reads the server's AWS_* variables or ~/.aws files for keys. Timeouts keep a
 * black-holed network from holding a request; the SDK's standard retry (3 attempts) absorbs brief throttling. close()
 * releases the client's sockets (a replaced configuration, a probe's one-off transport).
 */
import "server-only";
import { SendEmailCommand, SESv2Client, type SESv2ClientConfig } from "@aws-sdk/client-sesv2";
import { createTransport } from "nodemailer";
import type { EmailConfig } from "@/lib/integrations/types";
import type { EmailTransport } from "../transport";
import { mailOptions } from "./mail-options";

export type SesConfig = Extract<EmailConfig, { transport: "ses" }>;

/** The part of SESv2Client the transport uses (tests pass a fake). */
export type SesClientLike = {
  send(command: unknown): Promise<unknown>;
  destroy?(): void;
  /** nodemailer reads the region for the Message-ID domain. */
  config?: { region?: () => Promise<string> };
};

export const SES_TIMEOUTS = { connectionTimeout: 10_000, requestTimeout: 30_000 } as const;
export const SES_MAX_ATTEMPTS = 3;

/**
 * SESv2Client options for a configuration: region and keys only, never an endpoint, and no endpoint from the server
 * environment or shared config files (AWS_ENDPOINT_URL*, endpoint_url, FIPS and dual-stack switches).
 */
export function sesClientConfig(config: SesConfig): SESv2ClientConfig {
  return {
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    ignoreConfiguredEndpointUrls: true,
    useFipsEndpoint: false,
    useDualstackEndpoint: false,
    maxAttempts: SES_MAX_ATTEMPTS,
    requestHandler: { ...SES_TIMEOUTS, throwOnRequestTimeout: true, httpsAgent: { keepAlive: true } },
  };
}

/** A transport around nodemailer's SES transport. `client` is injectable (tests); default a new SESv2Client. */
export function createSesTransport(config: SesConfig, client: SesClientLike = new SESv2Client(sesClientConfig(config))): EmailTransport {
  const mailer = createTransport({ SES: { sesClient: client, SendEmailCommand } });
  const ses = config.configurationSet ? { ConfigurationSetName: config.configurationSet } : undefined;
  return {
    name: "ses",
    async send(message) {
      const info = (await mailer.sendMail({ ...mailOptions(message, config.from), ...(ses ? { ses } : {}) })) as { messageId?: unknown };
      return { messageId: typeof info.messageId === "string" ? info.messageId : "" };
    },
    close() {
      client.destroy?.();
    },
  };
}
