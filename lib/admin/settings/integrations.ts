/**
 * Integrations panel of Admin > Settings: whether payments, storage, email and Redis are configured, read from the
 * presence of environment variables. Never returns a value (no keys, hosts, bucket names or addresses), only driver
 * kinds, a status, the payment mode and the variable NAMES to set. Server-only (reads the parsed env).
 */
import "server-only";
import { isPaymentTestMode } from "@/lib/admin/context";
import type { Env } from "@/lib/env";
import type { IntegrationStatus, IntegrationView } from "./model";

type IntegrationEnv = Pick<
  Env,
  | "NODE_ENV"
  | "PAYMENT_PROVIDER"
  | "PAYMENT_KEY_ID"
  | "PAYMENT_KEY_SECRET"
  | "PAYMENT_WEBHOOK_SECRET"
  | "STORAGE_DRIVER"
  | "STORAGE_BUCKET"
  | "STORAGE_REGION"
  | "STORAGE_ENDPOINT"
  | "STORAGE_ACCESS_KEY_ID"
  | "STORAGE_SECRET_ACCESS_KEY"
  | "EMAIL_TRANSPORT"
  | "EMAIL_FROM"
  | "SMTP_HOST"
  | "REDIS_URL"
>;

const present = (value: string | null | undefined): boolean => typeof value === "string" && value.trim() !== "";

const PAYMENT_PROVIDERS: Record<IntegrationEnv["PAYMENT_PROVIDER"], string> = {
  razorpay: "Razorpay",
  cashfree: "Cashfree",
  mock: "Mock provider",
};

/** The four integration cards, in the prototype's order (payments, storage, email) plus Redis. */
export function integrationStatuses(env: IntegrationEnv): IntegrationView[] {
  const payments: IntegrationStatus =
    env.PAYMENT_PROVIDER === "mock"
      ? "development"
      : present(env.PAYMENT_KEY_ID) && present(env.PAYMENT_KEY_SECRET) && present(env.PAYMENT_WEBHOOK_SECRET)
        ? "configured"
        : "missing";
  const storage: IntegrationStatus =
    env.STORAGE_DRIVER === "local"
      ? "development"
      : present(env.STORAGE_BUCKET) &&
          present(env.STORAGE_ACCESS_KEY_ID) &&
          present(env.STORAGE_SECRET_ACCESS_KEY) &&
          (present(env.STORAGE_REGION) || present(env.STORAGE_ENDPOINT))
        ? "configured"
        : "missing";
  const email: IntegrationStatus =
    env.EMAIL_TRANSPORT === "console" ? "development" : present(env.SMTP_HOST) && present(env.EMAIL_FROM) ? "configured" : "missing";
  const redis: IntegrationStatus = present(env.REDIS_URL) ? "configured" : env.NODE_ENV === "production" ? "missing" : "development";

  return [
    {
      id: "payments",
      title: "Payment provider",
      description: "India-focused provider through the payment adapter.",
      icon: "credit_card",
      provider: PAYMENT_PROVIDERS[env.PAYMENT_PROVIDER],
      status: payments,
      mode: isPaymentTestMode(env) ? "test" : "live",
      envNames: ["PAYMENT_PROVIDER", "PAYMENT_KEY_ID", "PAYMENT_KEY_SECRET", "PAYMENT_WEBHOOK_SECRET"],
      note: "Keys: PAYMENT_KEY_ID / PAYMENT_KEY_SECRET (env)",
    },
    {
      id: "storage",
      title: "Installer storage",
      description: "Private bucket; signed URLs only.",
      icon: "cloud",
      provider: env.STORAGE_DRIVER === "s3" ? "S3-compatible bucket" : "Local disk",
      status: storage,
      envNames: ["STORAGE_DRIVER", "STORAGE_BUCKET", "STORAGE_REGION", "STORAGE_ENDPOINT", "STORAGE_ACCESS_KEY_ID", "STORAGE_SECRET_ACCESS_KEY"],
      note: "Credentials in env: STORAGE_*",
    },
    {
      id: "email",
      title: "Email delivery",
      description: "Transactional email sender.",
      icon: "outgoing_mail",
      provider: env.EMAIL_TRANSPORT === "smtp" ? "SMTP" : "Console (server log)",
      status: email,
      envNames: ["EMAIL_TRANSPORT", "EMAIL_FROM", "SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD"],
      note: "SMTP credentials in env: EMAIL_*, SMTP_*",
    },
    {
      id: "redis",
      title: "Rate limits",
      description: "Shared counters for sign-in, activation and API limits.",
      icon: "database",
      provider: present(env.REDIS_URL) ? "Redis" : "Database buckets",
      status: redis,
      envNames: ["REDIS_URL"],
      note: "Redis is required in production: REDIS_URL (env)",
    },
  ];
}
