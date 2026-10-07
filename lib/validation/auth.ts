/**
 * Request bodies of the auth API (app/api/auth/**, app/api/me/**). Strict objects: unknown keys are rejected.
 * Copy comes from the Account prototype (design_handoff_axiomatic/prototype/Account.dc.html).
 * Client-safe: the auth forms reuse these schemas for client-side checks.
 */
import { z } from "zod";
import { emailSchema } from "@/lib/validation/contact";
import { isLinkLikeName, NAME_LINK_ERROR } from "@/lib/validation/names";
import { PASSWORD_ERROR, passwordSchema } from "@/lib/validation/password";

export const NAME_MAX = 120;
export const BUSINESS_NAME_MAX = 160;
/** Same bound as lib/auth/password.ts MAX_PASSWORD_LENGTH: longer inputs are never hashed. */
export const PASSWORD_INPUT_MAX = 1024;
export const NEXT_MAX = 2048;

export const AUTH_FIELD_ERRORS = {
  name: "Enter your name.",
  nameTooLong: `Use ${NAME_MAX} characters or fewer.`,
  nameLink: NAME_LINK_ERROR,
  businessNameTooLong: `Use ${BUSINESS_NAME_MAX} characters or fewer.`,
  password: "Enter your password.",
  currentPassword: "Enter your current password.",
  newPassword: PASSWORD_ERROR,
  code: "Enter the 6-digit code.",
  resetToken: "This reset link isn’t valid. Request a new one.",
  challenge: "This code has expired. Sign in again to get a new code.",
} as const;

/** Optional post-auth destination. Anything odd becomes undefined (lib/auth/redirect.ts validates it later). */
const nextField = z.string().max(NEXT_MAX).optional().catch(undefined);

/** Six digits; spaces typed or pasted between digits are ignored. */
export const sixDigitCodeSchema = z
  .string({ error: AUTH_FIELD_ERRORS.code })
  .transform((v) => v.trim().replaceAll(" ", ""))
  .pipe(z.string().regex(/^[0-9]{6}$/, { message: AUTH_FIELD_ERRORS.code }));

const signInPasswordSchema = z
  .string({ error: AUTH_FIELD_ERRORS.password })
  .min(1, { message: AUTH_FIELD_ERRORS.password })
  .max(PASSWORD_INPUT_MAX, { message: AUTH_FIELD_ERRORS.password });

export const registerSchema = z.strictObject({
  name: z
    .string({ error: AUTH_FIELD_ERRORS.name })
    .trim()
    .min(1, { message: AUTH_FIELD_ERRORS.name })
    .max(NAME_MAX, { message: AUTH_FIELD_ERRORS.nameTooLong })
    .refine((value) => !isLinkLikeName(value), { message: AUTH_FIELD_ERRORS.nameLink }),
  email: emailSchema,
  password: passwordSchema,
  businessName: z
    .string()
    .trim()
    .max(BUSINESS_NAME_MAX, { message: AUTH_FIELD_ERRORS.businessNameTooLong })
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** Where to continue after verification (e.g. "/account/software?trial=medical-billing"). */
  next: nextField,
});
export type RegisterInput = z.output<typeof registerSchema>;

export const verifyEmailSchema = z.strictObject({
  code: sixDigitCodeSchema,
  next: nextField,
});
export type VerifyEmailInput = z.output<typeof verifyEmailSchema>;

export const signInSchema = z.strictObject({
  email: emailSchema,
  password: signInPasswordSchema,
  next: nextField,
});
export type SignInInput = z.output<typeof signInSchema>;

export const signInVerifySchema = z.strictObject({
  challengeId: z
    .string({ error: AUTH_FIELD_ERRORS.challenge })
    .min(1, { message: AUTH_FIELD_ERRORS.challenge })
    .max(256, { message: AUTH_FIELD_ERRORS.challenge }),
  code: sixDigitCodeSchema,
  trustDevice: z.boolean().optional().default(false),
});
export type SignInVerifyInput = z.output<typeof signInVerifySchema>;

export const forgotPasswordSchema = z.strictObject({ email: emailSchema });
export type ForgotPasswordInput = z.output<typeof forgotPasswordSchema>;

export const resetTokenSchema = z
  .string({ error: AUTH_FIELD_ERRORS.resetToken })
  .min(1, { message: AUTH_FIELD_ERRORS.resetToken })
  .max(512, { message: AUTH_FIELD_ERRORS.resetToken });

export const resetPasswordSchema = z.strictObject({
  token: resetTokenSchema,
  password: passwordSchema,
});
export type ResetPasswordInput = z.output<typeof resetPasswordSchema>;

export const changePasswordSchema = z.strictObject({
  current: z
    .string({ error: AUTH_FIELD_ERRORS.currentPassword })
    .min(1, { message: AUTH_FIELD_ERRORS.currentPassword })
    .max(PASSWORD_INPUT_MAX, { message: AUTH_FIELD_ERRORS.currentPassword }),
  next: passwordSchema,
});
export type ChangePasswordInput = z.output<typeof changePasswordSchema>;

/** Bodies of endpoints that take no input (resend-code, sign-out): nothing, or an empty JSON object. */
export const emptyBodySchema = z.strictObject({});
