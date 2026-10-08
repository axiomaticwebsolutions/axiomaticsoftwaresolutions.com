/**
 * The real SESv2 client built from sesClientConfig() (lib/email/transports/ses.ts) always resolves AWS's own endpoint
 * for the region, whatever the server environment says (AWS_ENDPOINT_URL, AWS_ENDPOINT_URL_SESV2, the FIPS and
 * dual-stack switches). Nothing is sent: a build-step middleware records the resolved host and stops the request.
 */
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sesClientConfig, type SesConfig } from "@/lib/email/transports/ses";

const SES: SesConfig = {
  transport: "ses",
  region: "ap-south-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "ses-secret-access-key-01",
  configurationSet: null,
  from: { name: "Axiomatic Software", address: "no-reply@axiomatic.example" },
};

class Stop extends Error {
  constructor(readonly host: string) {
    super("stopped before sending");
  }
}

async function resolvedHost(config: SesConfig): Promise<string> {
  const client = new SESv2Client(sesClientConfig(config));
  client.middlewareStack.add(
    () => async (args) => {
      throw new Stop(String((args.request as { hostname?: unknown }).hostname));
    },
    { step: "build", name: "recordHost", priority: "high" },
  );
  try {
    await client.send(new SendEmailCommand({ Content: { Raw: { Data: new TextEncoder().encode("x") } } }));
    return "sent";
  } catch (error) {
    if (error instanceof Stop) return error.host;
    throw error;
  } finally {
    client.destroy();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SES endpoint", () => {
  it("is email.<region>.amazonaws.com", async () => {
    expect(await resolvedHost(SES)).toBe("email.ap-south-1.amazonaws.com");
    expect(await resolvedHost({ ...SES, region: "eu-west-1" })).toBe("email.eu-west-1.amazonaws.com");
  });

  it("ignores endpoint, FIPS and dual-stack settings in the server environment", async () => {
    vi.stubEnv("AWS_ENDPOINT_URL", "https://elsewhere.example.invalid");
    vi.stubEnv("AWS_ENDPOINT_URL_SESV2", "https://elsewhere-sesv2.example.invalid");
    vi.stubEnv("AWS_USE_FIPS_ENDPOINT", "true");
    vi.stubEnv("AWS_USE_DUALSTACK_ENDPOINT", "true");
    expect(await resolvedHost(SES)).toBe("email.ap-south-1.amazonaws.com");
  });
});
