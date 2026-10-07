/**
 * Pure helpers behind the auth forms: client-side checks (the same Zod schemas the API uses, so the messages match
 * the prototype), code input sanitising, the password hint, `next`/`trial` handling and redirect-target checks.
 * Client-safe; unit tested in tests/unit/auth-ui-model.test.ts.
 */
import { safeNext } from "@/lib/auth/redirect";
import {
  AUTH_FIELD_ERRORS,
  forgotPasswordSchema,
  registerSchema,
  signInSchema,
  sixDigitCodeSchema,
} from "@/lib/validation/auth";
import { isAcceptablePassword, passwordSchema } from "@/lib/validation/password";
import { AUTH_COPY } from "./copy";

export const CODE_LENGTH = 6;
/** Seconds before "Resend code" works again after a code was sent. */
export const RESEND_COOLDOWN_SEC = 30;
/** Query flag /register adds to the /verify URL so it can say "Account created…". */
export const CREATED_PARAM = "created";

export type FieldErrorMap<K extends string> = Partial<Record<K, string>>;

type Issue = { path: ReadonlyArray<PropertyKey>; message: string };
type SafeParse = { success: true } | { success: false; error: { issues: ReadonlyArray<Issue> } };

/** First message per top-level field, limited to `keys` (anything else is ignored). */
export function issuesToFieldErrors<K extends string>(result: SafeParse, keys: readonly K[]): FieldErrorMap<K> {
  if (result.success) return {};
  const out: FieldErrorMap<K> = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (typeof key !== "string" || !(keys as readonly string[]).includes(key)) continue;
    const k = key as K;
    if (!out[k]) out[k] = issue.message;
  }
  return out;
}

/** Field errors from a 422 `validation_failed` body (first message per field), limited to `keys`. */
export function serverFieldErrors<K extends string>(fieldErrors: Record<string, string[]>, keys: readonly K[]): FieldErrorMap<K> {
  const out: FieldErrorMap<K> = {};
  for (const key of keys) {
    const first = fieldErrors[key]?.[0];
    if (first) out[key] = first;
  }
  return out;
}

export function hasErrors(errors: Partial<Record<string, string>>): boolean {
  return Object.values(errors).some(Boolean);
}

export type SignInField = "email" | "password";
export const SIGN_IN_FIELDS = ["email", "password"] as const satisfies readonly SignInField[];

export function validateSignIn(values: { email: string; password: string }): FieldErrorMap<SignInField> {
  return issuesToFieldErrors(signInSchema.safeParse({ email: values.email, password: values.password }), SIGN_IN_FIELDS);
}

export type RegisterField = "name" | "businessName" | "email" | "password";
export const REGISTER_FIELDS = ["name", "businessName", "email", "password"] as const satisfies readonly RegisterField[];

export function validateRegister(values: Record<RegisterField, string>): FieldErrorMap<RegisterField> {
  return issuesToFieldErrors(registerSchema.safeParse(values), REGISTER_FIELDS);
}

export type ForgotField = "email";
export const FORGOT_FIELDS = ["email"] as const satisfies readonly ForgotField[];

export function validateForgot(values: { email: string }): FieldErrorMap<ForgotField> {
  return issuesToFieldErrors(forgotPasswordSchema.safeParse(values), FORGOT_FIELDS);
}

export type ResetField = "password" | "confirm";
export const RESET_FIELDS = ["password", "confirm"] as const satisfies readonly ResetField[];

/** New password policy, and "Passwords don’t match." whenever the two differ (prototype). */
export function validateReset(values: { password: string; confirm: string }): FieldErrorMap<ResetField> {
  const out: FieldErrorMap<ResetField> = {};
  const policy = passwordSchema.safeParse(values.password);
  if (!policy.success) out.password = policy.error.issues[0]?.message ?? AUTH_COPY.strength.weak;
  if (values.confirm !== values.password) out.confirm = AUTH_COPY.reset.mismatch;
  return out;
}

export type CodeField = "code";
export const CODE_FIELDS = ["code"] as const satisfies readonly CodeField[];

export function validateCode(code: string): FieldErrorMap<CodeField> {
  const parsed = sixDigitCodeSchema.safeParse(code);
  if (parsed.success) return {};
  return { code: parsed.error.issues[0]?.message ?? AUTH_FIELD_ERRORS.code };
}

/** Typing: digits only, at most six. */
export function sanitizeCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

/**
 * Pasting: a standalone six-digit group wins ("Your code: 482 913 expires in 15 minutes" -> "482913"), otherwise the
 * first six digits of the text.
 */
export function codeFromPaste(text: string): string {
  const group = /(?<!\d)(\d{3})[\s-]?(\d{3})(?!\d)/.exec(text);
  if (group) return `${group[1]}${group[2]}`;
  return sanitizeCode(text);
}

export type PasswordStrength = { state: "empty" | "weak" | "good"; message: string };

/** The live hint under new-password fields: nothing until typing starts, then the policy or "Good password". */
export function passwordStrength(password: string): PasswordStrength {
  if (password === "") return { state: "empty", message: "" };
  return isAcceptablePassword(password)
    ? { state: "good", message: AUTH_COPY.strength.good }
    : { state: "weak", message: AUTH_COPY.strength.weak };
}

const TRIAL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TRIAL_PORTAL_PATH = "/account/software";
const PROBE = "http://next.invalid";

/** A product slug as used by the trial CTA (`?trial=medical-billing`), else null. */
export function trialSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  return slug.length > 0 && slug.length <= 80 && TRIAL_SLUG_RE.test(slug) ? slug : null;
}

/**
 * Where registration continues after verification. The trial CTA links to `/register?next=/account/software&trial=
 * <slug>`; the slug rides inside `next` (`/account/software?trial=<slug>`), so it survives the emailed-code step.
 */
export function continuePath(next: unknown, trial: unknown): string | null {
  const safe = safeNext(next);
  const slug = trialSlug(trial);
  if (!slug) return safe;
  const url = new URL(safe ?? TRIAL_PORTAL_PATH, PROBE);
  url.searchParams.set("trial", slug);
  return safeNext(`${url.pathname}${url.search}${url.hash}`);
}

/** `path?next=<encoded>` when next is safe, else `path`. */
export function withNext(path: string, next: string | null | undefined): string {
  const safe = safeNext(next);
  return safe ? `${path}?next=${encodeURIComponent(safe)}` : path;
}

/**
 * Redirect targets come from our own API but are checked before `location.assign`: a same-origin path only (auth
 * pages such as /verify are allowed here, unlike safeNext).
 */
export function safeRedirectTarget(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length > 4096) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return fallback;
  }
  return value;
}

/** Adds `created=1` to the /verify URL returned by register. */
export function withCreatedFlag(path: string): string {
  const url = new URL(path, PROBE);
  url.searchParams.set(CREATED_PARAM, "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The URL without `created` (the notice shows once; a reload does not repeat it). */
export function withoutCreatedFlag(pathAndSearch: string): string {
  const url = new URL(pathAndSearch, PROBE);
  url.searchParams.delete(CREATED_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Seconds from a 429 body (`retryAfterSec`), between 1 and 3600; null when absent. */
export function retryAfterFrom(details: Readonly<Record<string, unknown>>): number | null {
  const value = details.retryAfterSec;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.min(3600, Math.max(1, Math.ceil(value)));
}

/** Prefill from `?email=`: only something that looks like an address, trimmed and lower-cased. */
export function emailPrefill(value: unknown): string {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

// Name helpers live with the header account menu, which must not import this module (it pulls the Zod schemas
// into every storefront page); re-exported here for the auth forms and tests.
export { firstName, initials } from "./account-menu-model";
