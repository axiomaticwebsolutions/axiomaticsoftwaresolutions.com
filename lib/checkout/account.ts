/**
 * "Create an account to manage licenses and downloads" at checkout (decisions.md Phase 3): inside the order
 * transaction, creates an unverified customer, a BusinessAccount (legal name = business name, else the person's name,
 * with the billing details) and an OWNER membership, plus the email verification code through the auth module
 * (lib/auth/flows/verify-email.ts: keyed hash only, 15 minutes, 5 attempts). The caller emails the code after commit
 * with sendVerificationEmail() and signs the user in. Same rules and copy as POST /api/auth/register, including the
 * takeover of an invited address's placeholder user (takeOverPlaceholderUser; its invitations stay pending).
 */
import { MemberStatus, TeamRole, UserKind } from "@/generated/prisma/enums";
import type { BusinessAccount, User } from "@/generated/prisma/client";
import { AUTH_MESSAGES, takeOverPlaceholderUser } from "@/lib/auth/flows/common";
import { issueEmailVerificationCode } from "@/lib/auth/flows/verify-email";
import type { Tx } from "@/lib/db";
import type { BillingSnapshot } from "@/lib/orders/billing";

/** Register copy from Account.dc.html (409 `email_taken`). */
export const EMAIL_TAKEN_MESSAGE: string = AUTH_MESSAGES.emailTaken;

export type CheckoutCustomer = { user: User; account: BusinessAccount; verificationCode: string };

/**
 * Creates the customer, account, membership and verification code. Run inside the order transaction.
 * `next` is where verification sends the customer (the order page).
 */
export async function createCheckoutCustomer(
  tx: Tx,
  input: { billing: BillingSnapshot; passwordHash: string; now: Date; next?: string | null },
): Promise<CheckoutCustomer> {
  const { billing, passwordHash, now } = input;
  const user =
    (await takeOverPlaceholderUser(tx, { email: billing.email, name: billing.name, phone: billing.phone, passwordHash, now })) ??
    (await tx.user.create({
      data: {
        kind: UserKind.CUSTOMER,
        email: billing.email,
        name: billing.name,
        phone: billing.phone,
        passwordHash,
        emailVerifiedAt: null,
        lastActiveAt: now,
        createdAt: now,
      },
    }));
  const account = await tx.businessAccount.create({
    data: {
      legalName: billing.business ?? billing.name,
      gstin: billing.gstin,
      address: billing.address,
      city: billing.city,
      state: billing.state,
      pin: billing.pin,
      createdAt: now,
    },
  });
  await tx.accountMember.create({
    data: { accountId: account.id, userId: user.id, role: TeamRole.OWNER, status: MemberStatus.ACTIVE, createdAt: now },
  });
  const verificationCode = await issueEmailVerificationCode(tx, user, { next: input.next ?? null, now });
  return { user, account, verificationCode };
}
