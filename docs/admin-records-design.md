# Admin records: customers and orders (design, 2026-10-08)

Owner request: let staff confirm a customer's email by hand, and create and edit customers and orders from the Admin
console. This document is the implementation contract for branch `admin-records`. Each decision below gets a dated entry
in `docs/decisions.md` when it is built. Paths are relative to the repository root.

- **Shared step S0:** schema, permissions, rate limits and email templates. Build it first, in one change.
- **PART A, Customers (Owner, Administrator, Support):** mark verified, create, edit, set-password links.
- **PART B, Orders (Owner, Finance):** quote, payment-link orders, offline payments, unpaid edits, cancel, and billing
  corrections with a credit note and a new invoice.

PART A and PART B touch different files after S0, so they can be built in parallel. Section 9 lists the few shared
files and who edits them.

---

## 0. Decisions at a glance

| # | Decision | Why |
|---|---|---|
| D1 | One additive migration `admin_records`: 3 columns on `Order`, 4 on `Payment`, 1 on `User`, new table `InvoiceCorrection`. No enum changes. No column becomes nullable or loses a constraint. | The requirements ask for additive migrations only. Fewer changes elsewhere than changing an enum. |
| D2 | 7 new permissions. Customers: `customers.create`, `customers.edit`, `customers.verify_email` (Owner, Administrator, Support). Orders: `orders.create`, `orders.edit`, `payments.record_offline`, `invoices.correct` (Owner, Finance). `customers.manage` (existing) also covers set-password links. | The role sets were set by the owner. Separate keys keep the permission matrix and audit log clear. |
| D3 | 3 new `DESTRUCTIVE_ACTIONS` keys: `customers.verify_email`, `customers.set_password_link`, `orders.cancel`. These are one-click confirmations with a reason. Form actions (create, edit, offline payment, billing correction) take a `reason` field and use `requireReason()`. | `DestructiveAction` is the existing button-plus-confirm pattern. Forms already have a place for the reason. |
| D4 | Every new write action requires a reason (4 to 500 characters). The exceptions are the read-only quote, re-sharing or emailing an existing payment link (audited without a reason), and PDF downloads. | Owner requirement B3, "reasons required". |
| D5 | Customers created by staff have **no password**. The staff member gets a single-use **set-password link** shown once. It is a `PASSWORD_RESET` token with `meta.purpose = "set_password"`, valid 7 days, opened on the existing `/reset` page, which then reads "Set your password". The same link is emailed directly with the new `set_password` template. If the email fails, creation still succeeds. | Reuses the reset flow and its hashing and single-use rules. Nobody but the customer chooses the password. |
| D6 | `User.createdByStaffId` marks customers created by staff. Such a user is **never a placeholder**, so `/register` and checkout "Create an account" can no longer take the account over. `/forgot` sends staff-created users without a password a 30-minute set-password link, so they are not locked out. | Closes the takeover hole described in section A2.4. Gives the customer a way back in on their own. |
| D7 | Completing a set-password link does **not** verify the email, same as a reset today. Staff verify on purpose: the "Email already verified" box, or "Mark email as verified". | A copied link proves only that someone has the link, not that they own the address. |
| D8 | Marking an email verified runs `claimGuestOrders` in the same transaction, exactly as code verification does. | Same business rule as code verification. The consequence is shown in the confirmation. |
| D9 | An email change bumps `securityEpoch`, revokes every session, voids open `EMAIL_VERIFY`, `PASSWORD_RESET` and `LOGIN_OTP` tokens, and clears verification unless the editor ticks "verified" (needs `customers.verify_email`). An outbox email `account_email_changed` goes to the **old** address. | Matches what staff deactivation does. Telling the old address protects against social-engineering takeovers. |
| D10 | Payment-link orders are created **without a provider order** (zero `Payment` rows). The customer's first "Pay now" goes through the existing `retryPayment`, which creates a fresh provider order at the current total. | No provider order can go stale, and the admin console makes no provider call. The retry path already handles orders with no payment. |
| D11 | The customer must accept the terms before paying an order created by staff. The order page shows the checkout terms checkbox, and `retry` records `termsAcceptedAt` and `termsVersion`. | Checkout normally records acceptance. Staff cannot accept on the customer's behalf. |
| D12 | Offline payment: one transaction creates the order, a `Payment` row (`provider "offline"`, `CAPTURED`) and runs the **same** fulfilment as the webhook through the extracted `fulfilPaidOrder()`. `paidAt` is the moment staff record it. The received date is stored separately in `Payment.receivedAt`. | This is the only exception to "licenses come only from the webhook". Back-dated invoices would break the order of invoice numbers by date, and license terms start at delivery. |
| D13 | Double-submit safety comes from a client-generated `requestId` stored in `Order.staffRequestId @unique`. A repeat returns the existing order (`replayed: true`) and stores nothing new. | There is no other idempotency mechanism for admin writes. |
| D14 | Editing an unpaid order re-prices it with `priceCart`, replaces its items, sets every open payment attempt to `CANCELED` and stamps them `supersededAt`. The webhook sends a capture of a superseded attempt to `REVIEW`. `retryPayment` reopens a `CREATED` attempt only when its amount equals the order total. | A Razorpay order cannot be withdrawn at the provider. These are the backstops. |
| D15 | A staff cancel sets `CANCELED` and `Order.canceledByStaffAt`. Retry refuses such orders, so the customer cannot reopen them. | A customer can retry an order they cancelled themselves. A staff cancel must be final. |
| D16 | Billing correction uses a new append-only table `InvoiceCorrection` (**Option A**). The `Invoice` row is updated in place to the new number and date. `Order.billing` takes the corrected values. The cancelled original (number, date, billing, seller) and the credit note live on the correction row. Reports add the cancelled originals back into their original month and count the correction credit notes. | Fewest changes: about 20 call sites keep reading `order.invoice`. The alternative, several invoices per order, means dropping `Invoice.orderId @unique`, which is not additive. |
| D17 | A billing correction is allowed only for `PAID` orders that have an invoice and no `PENDING` or `PROCESSED` refund. The billing **state** (place of supply) and **email** cannot change. The seller's state must still be the one on the original invoice. | With the place of supply fixed, the GST split cannot change. A partly refunded order already has a credit note against the original invoice. |
| D18 | New documents: a credit-note PDF (`buildInvoiceModel` with a document kind) and a "Replaces invoice …" note on the new invoice. Admin and customers download both. | Owner requirement B2. |
| D19 | Staff sessions never get the one-time license key delivery (`isPurchaser = false` for `STAFF`), even when they hold the order link. | A staff member opening a copied payment link after payment would otherwise use up the customer's one-time key view. |
| D20 | Orders paid offline cannot be refunded in the console in this release. The refund action stays disabled and says why. This is a documented follow-up. | The refund path needs a provider payment id. A manual refund path is a separate design. |

---

## 1. Data model and migration (S0)

Create it with `pnpm prisma migrate dev --name admin_records` against `axiomatic_ui`. The generated SQL must contain
only `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX` and `ADD CONSTRAINT`.

### 1.1 Schema changes (`prisma/schema.prisma`)

```prisma
model User {
  // ...existing fields...
  createdByStaffId String? // staff user id when Admin > Customers created this customer (never a placeholder; /forgot sends set-password links)
}

model Order {
  // ...existing fields...
  createdByStaffId  String?   // staff user id for orders created in Admin > Orders (payment link or offline payment)
  staffRequestId    String?   @unique // client-generated id of the create request (double-submit guard)
  canceledByStaffAt DateTime? // set by the admin cancel: the order can't be paid again (retryPayment refuses it)
  invoiceCorrections InvoiceCorrection[]
}

model Payment {
  // ...existing fields...
  reference    String?   // offline: UTR / cheque number / receipt reference (not unique: one transfer can pay two orders)
  receivedAt   DateTime? // offline: the day the money was received (IST midnight); paidAt/capturedAt is when staff recorded it
  recordedById String?   // offline: the staff user who recorded it
  supersededAt DateTime? // a staff edit replaced this attempt; a late capture of it sends the order to REVIEW
}

/// One billing correction of a paid order: credit note AXC/.. cancels the then-current invoice in full and a new
/// invoice (Invoice.number = newInvoiceNo) is issued with the corrected billing. Append-only.
model InvoiceCorrection {
  id                String   @id @default(cuid())
  orderId           String
  order             Order    @relation(fields: [orderId], references: [id])
  creditNoteNo      String   @unique // "AXC/26-27/0004", from the shared credit note counter
  originalInvoiceNo String   @unique // the invoice this cancelled, as issued
  originalIssuedAt  DateTime
  originalBilling   Json     // Order.billing printed on the cancelled invoice (also the credit note's recipient)
  originalSeller    Json     // Invoice.seller of the cancelled invoice
  newInvoiceNo      String   @unique // the replacement invoice
  billing           Json     // the corrected billing snapshot (printed on the new invoice)
  seller            Json     // seller snapshot of the credit note and the new invoice (sellerSnapshot(settings.business))
  sac               String
  taxablePaise      Int      // the cancelled invoice's amounts (= order totals; amounts never change)
  cgstPaise         Int
  sgstPaise         Int
  igstPaise         Int
  totalPaise        Int
  changedFields     String[] // ["gstin", "address"]: names only
  reason            String
  createdById       String   // staff user id
  issuedAt          DateTime // date of the credit note and of the new invoice
  createdAt         DateTime @default(now())

  @@index([orderId, issuedAt])
  @@index([issuedAt])
  @@index([originalIssuedAt])
}
```

- `AuthToken` is unchanged: the set-password purpose lives in `meta` (`{ purpose: "set_password", issuedById? }`).
- Fix the comment in `lib/orders/billing.ts:1-4`. It should say the snapshot changes only through an audited billing
  correction (`InvoiceCorrection` keeps the original).
- Fix the comment on `Invoice` in the schema. It should say the row is the order's **current** tax invoice, and
  earlier numbers are in `InvoiceCorrection`.

### 1.2 Constants

| Constant | Where | Value |
|---|---|---|
| `OFFLINE_PROVIDER = "offline"` | `lib/payments/types.ts` (not a `PaymentProviderKey`) | Provider string on offline `Payment` rows |
| `offlineProviderOrderId(orderId)` | same | `` `offline:${orderId}` `` (unique, because order ids are) |
| `OFFLINE_METHOD_LABELS` | `lib/admin/orders/model.ts` | cash→"Cash", upi→"UPI", bank_transfer→"Bank transfer", cheque→"Cheque", other→"Other" (stored in `Payment.method`) |
| `SET_PASSWORD_TTL_MS = 7 * DAY_MS` | `lib/auth/flows/common.ts` | Staff-issued set-password links |
| `SET_PASSWORD_PURPOSE = "set_password"` | same | `AuthToken.meta.purpose` |
| `OFFLINE_RECEIVED_MAX_AGE_DAYS = 180` | `lib/admin/orders/schemas.ts` | How far back "Received on" can go |

---

## 2. Permissions, destructive keys and rate limits (S0)

### 2.1 `lib/rbac.ts`

Add these to `PERMS`, keeping each next to its group:

```ts
"customers.create": ["OWNER", "ADMIN", "SUPPORT"],
"customers.edit": ["OWNER", "ADMIN", "SUPPORT"],
"customers.verify_email": ["OWNER", "ADMIN", "SUPPORT"],
"orders.create": ["OWNER", "FINANCE"],
"orders.edit": ["OWNER", "FINANCE"],
"payments.record_offline": ["OWNER", "FINANCE"],
"invoices.correct": ["OWNER", "FINANCE"],
```

Permission counts change from Owner/Admin/Support/Finance = 22/18/8/8 to **29/21/11/12**. 29 permissions in total.

Add these to `DESTRUCTIVE_ACTIONS`. `typedId` is `false` for all three:

```ts
"customers.verify_email": { perm: "customers.verify_email", reason: true, typedId: false, label: "Mark verified" },
"customers.set_password_link": { perm: "customers.manage", reason: true, typedId: false, label: "Create link" },
"orders.cancel": { perm: "orders.edit", reason: true, typedId: false, label: "Cancel order" },
```

Change these module descriptions in `ADMIN_MODULES`:

- `orders`: "Orders are marked paid after a verified payment webhook, or when Owner or Finance record an offline
  payment. Refunds revoke the licenses they issued."
- `customers`: "Businesses that have bought or trialled software. Staff can add customers, fix their details and
  confirm emails. Guest purchases link to an account by email."

Every place below must change with the permissions. All of them are in S0:

- `lib/admin/staff/model.ts` `PERMISSION_LABELS`:
  - `customers.create` "Create customers"
  - `customers.edit` "Edit customer details & emails"
  - `customers.verify_email` "Mark emails as verified"
  - `customers.manage` "Resend verification, password resets & set-password links" (changed)
  - `orders.create` "Create orders & payment links"
  - `orders.edit` "Edit & cancel unpaid orders"
  - `payments.record_offline` "Record offline payments"
  - `invoices.correct` "Correct billing on paid orders"
- `lib/admin/destructive.ts` `DESTRUCTIVE_AUDIT_ACTIONS`:
  - `customers.verify_email` "Marked email as verified"
  - `customers.set_password_link` "Created set-password link"
  - `orders.cancel` "Cancelled order"
- `components/admin/destructive-action.tsx` `DESTRUCTIVE_COPY`:
  - `customers.verify_email`: trigger "Mark email as verified", icon `verified`, variant `default`, tone `primary`,
    title `` (t) => `Mark ${t} as verified?` ``.
  - `customers.set_password_link`: trigger "Create set-password link", icon `lock_reset`, variant `default`, tone
    `primary`, title `` (t) => `Create a set-password link for ${t}?` ``.
  - `orders.cancel`: trigger "Cancel order", icon `cancel`, variant `danger`, tone `danger`, title
    `` (t) => `Cancel ${t}?` ``.
- Tests:
  - `tests/unit/rbac.test.ts`: the `EXPECTED` map, the counts (`toHaveLength(29)`) and the destructive rules. The
    typed-id list is unchanged.
  - `tests/unit/admin-staff-model.test.ts`: counts 29/21/11/12 and the label keys.
  - `tests/unit/admin-destructive.test.ts`: the full audit label map.
- Docs: the permissions table in `docs/api.md` and business rule 7 in `docs/decisions.md`.

### 2.2 Rate limits

Add these to the `RATE_LIMITS` "Admin console" block in `lib/auth/rate-limit.ts`:

| Rule | Key | Limit | Used by |
|---|---|---|---|
| `adminCustomerCreate(staffId)` | `admin-customer-create:user:<h>` | 30 / hour | POST /api/admin/customers |
| `adminCustomerWrite(staffId)` | `admin-customer-write:user:<h>` | 60 / 10 min | PATCH customer, verify-email, set-password-link |
| `adminSetPasswordLink(userId)` | `admin-set-password:user:<h>` | 5 / hour per customer (`attempt`: refused tries are not counted) | set-password-link |
| `adminOrderQuote(staffId)` | `admin-order-quote:user:<h>` | 120 / 10 min | POST /api/admin/orders/quote |
| `adminOrderCreate(staffId)` | `admin-order-create:user:<h>` | 30 / hour | POST /api/admin/orders, POST /api/admin/orders/offline |
| `adminOrderWrite(staffId)` | `admin-order-write:user:<h>` | 60 / 10 min | PATCH order, cancel, payment-link, correct-billing |

Apply them in the route after `body()` with `enforce(await hit(db, rule))`, as the staff invite route does. The per-customer
`adminSetPasswordLink` rule is applied in the service with `attempt`.

The set-password links do **not** share `forgotEmail(email)`. Anyone can fill that bucket through `/forgot`, which
would stop staff from helping the customer.

### 2.3 Email templates (S0)

Edit `lib/email/defaults.ts`, the seed `prisma/seed-data/content.ts` `NOTIFICATION_TEMPLATES`, and the labels in
`lib/admin/templates/model.ts`. Update the tests that list template ids: `tests/unit/email-render.test.ts`,
`email-send.test.ts`, `admin-content-templates-leads-model.test.ts` and `tests/db/admin-templates-service.test.ts`.

| Id | Kind | Vars (required*) | Copy |
|---|---|---|---|
| `set_password` | AUTH (direct, never stored; add to `AUTH_EMAIL_TEMPLATE_IDS`) | customer_name*, set_password_url*, expires_in*, business_name | Subject "Set your Axiomatic password". Body: "Hi {{customer_name}},\n\nWe’ve set up an Axiomatic account for you. Choose a password with the button below to sign in, download your software and manage your licenses. The link works once and expires in {{expires_in}}.\n\n" + SIGN_OFF. Button "Set your password" (`set_password_url`). Note: "If the link has expired, use “Forgot password” on the sign-in page to get a new one." |
| `account_email_changed` | BUSINESS (outbox) | customer_name*, new_email_hint* | Subject "Your Axiomatic sign-in email was changed". Body: "Hi {{customer_name}},\n\nOur support team changed the email address of your Axiomatic account to {{new_email_hint}}, and signed you out on every device.\n\nIf you didn’t ask for this, reply to this email straight away.\n\n" + SIGN_OFF. |
| `order_payment_link` | BUSINESS (outbox; like `payment_failed`, the order link is not a credential) | customer_name*, order_id*, order_url*, total* | Subject "Your order {{order_id}} is ready to pay". Body: "Hi {{customer_name}},\n\nWe’ve prepared order {{order_id}} for you. Check the items, then pay securely from the order page. We issue your licenses as soon as the payment is confirmed.\n\n" + SIGN_OFF. Details: Order, Total. Button "Review and pay" (`order_url`). Note: "This link works for 30 days." |

---

## 3. Shared building blocks

### 3.1 Validation exports (`lib/validation/portal.ts`)

Export the existing private schemas `personNameSchema`, `phoneFieldSchema`, `legalNameSchema`, `gstinFieldSchema`,
`stateFieldSchema`, `pinFieldSchema` and `optionalLine`. Do not change their behaviour.

### 3.2 Pricing buyer, without a session (`lib/checkout/buyer.ts`, `lines.ts`, `quote.ts`)

```ts
/** What pricing needs to know about the buyer (CheckoutBuyer is assignable to it). */
export type PricingBuyer =
  | { kind: "guest" }
  | { kind: "staff" }
  | { kind: "customer"; membership: { accountId: string; role: TeamRole } | null };

/** Admin orders price as the account's owner would (target lines are checked against that account). */
export function accountPricingBuyer(accountId: string | null): PricingBuyer {
  return accountId ? { kind: "customer", membership: { accountId, role: "OWNER" } } : { kind: "guest" };
}
```

- `validateCheckoutLines(db, items, buyer: PricingBuyer, ctx, now)` and `priceCart(db, input, buyer: PricingBuyer, now)`
  change their parameter type only. They read only `kind`, `membership.accountId` and `membership.role` (checked in
  `lines.ts:118-178`).
- `PriceCartInput` gains `excludeOrderId?: string | null`. It is passed to `loadPricingContext({ ..., excludeOrderId })`,
  then to `heldCouponSlots(db, code, { now, excludeOrderId })`. This way an edited order does not count its own
  coupon slot.

### 3.3 Order creation data, shared with checkout (`lib/checkout/create-order.ts`)

Move two pieces out of `createCheckoutOrder` without changing their behaviour. Checkout and admin then build orders
from the same code:

```ts
/** 422 cart_invalid (issues) / couponCode / items empty / zero_total, exactly as checkout refuses a cart. */
export function assertPricedCart(priced: PricedCart): void;

/** The Order.create data for a priced cart (checkout and admin): amounts, line snapshots, placeOfSupply = billing.state. */
export function orderCreateData(input: {
  id: string; accountId: string | null; placedByUserId: string | null; billing: BillingSnapshot;
  quote: Quote; couponCode: string | null; now: Date;
  terms: { acceptedAt: Date; version: string } | null;      // checkout: { now, CHECKOUT_TERMS_VERSION }; admin: null
  staff?: { createdByStaffId: string; staffRequestId: string };
}): Prisma.OrderUncheckedCreateInput;
```

`tests/db/checkout-orders.test.ts` must stay green unchanged. That proves checkout still behaves the same.

### 3.4 Fulfilment shared by the webhook and offline payments

Create **`lib/payments/fulfilment.ts`** (`"server-only"`). Move these out of `lib/payments/webhook.ts` unchanged
except for their signatures:

- `ensureInvoice` (256-265), `redeemCoupon` (268-294), `issuedLicenses` (298-308)
- `announcePaidOrder` (310-379): it now takes `(tx, { order, now, invoiceNumber, issued })` instead of `ctx`
- `billingName`, `plural`, `orderUrl`
- `sellerSnapshot`: keep a re-export from `webhook.ts`

Add:

```ts
export type PaidOrderRow = Order & { placedBy: { name: string } | null };
export type IssuedLicense = { id: string; keyLast4: string; productName: string };
export type FulfilPaidOrderResult = { invoiceNumber: string; results: FulfilResult[]; issued: IssuedLicense[] };

/**
 * Marks a locked, unpaid order PAID and fulfils it: licenses (lib/licensing/fulfil.ts, keys sealed with HMAC +
 * AES-GCM + last4, terms snapshots), the tax invoice number (allocated late), the coupon redemption, account activity,
 * member notifications and the outbox emails. The caller holds the order row lock (SELECT ... FOR UPDATE) in `tx`
 * and writes its own audit row. Throws FulfilmentError / LicenseTermsError / DocumentSeriesExhaustedError.
 */
export async function fulfilPaidOrder(tx: Tx, input: { order: PaidOrderRow; paidAt: Date; now: Date }): Promise<FulfilPaidOrderResult> {
  await tx.order.update({ where: { id: input.order.id }, data: { status: OrderStatus.PAID, paidAt: input.paidAt, failReason: null } });
  const results = await fulfilOrderItems(tx, { id: input.order.id, accountId: input.order.accountId, paidAt: input.paidAt });
  const settings = await getSettings(tx);
  const invoice = await ensureInvoice(tx, input.order.id, input.paidAt, settings);
  await redeemCoupon(tx, input.order);
  const issued = await issuedLicenses(tx, results);
  await announcePaidOrder(tx, { order: input.order, now: input.now, invoiceNumber: invoice.number, issued });
  return { invoiceNumber: invoice.number, results, issued };
}
```

`onCaptured` (webhook.ts:431-449) becomes `state.fulfilling = true;`, then `const f = await fulfilPaidOrder(...)`,
then the same "Webhook processed" audit built from `f.invoiceNumber`, `f.issued` and `f.results`. Only the order of
the audit insert and the announcement inside the transaction changes. Every existing webhook, refund, reconcile and
invoice test must pass unchanged.

`announcePaidOrder` changes for orders created by staff (`order.createdByStaffId !== null`): the "Placed order"
activity row uses `actorId: null` and `actorName: "Axiomatic team"`.

The webhook also gets a stale-attempt backstop (D14). In `onCaptured`, just before the amount mismatch check:

```ts
if (payment.supersededAt !== null) -> order REVIEW, failReason SUPERSEDED_ATTEMPT_REASON, SYSTEM audit (orderReview),
   result "amount_mismatch", no licenses.
export const SUPERSEDED_ATTEMPT_REASON = "This payment was made for an earlier version of the order. Our team will review it.";
```

Audit detail for this case: `` `Payment for an attempt replaced by a staff edit: captured ${amount} (${provider} ${payId}). No licenses issued.` ``

### 3.5 Invoice and credit-note document model (`lib/invoice/model.ts`, `pdf.tsx`, `load.ts`)

`InvoiceModelInput` gains:

```ts
document?:
  | { kind: "invoice"; replaces?: { invoiceNo: string; creditNoteNo: string } | null }
  | { kind: "credit_note"; against: { number: string; issuedAt: string | Date }; replacedBy: string | null };
```

The default is `{ kind: "invoice" }`. `invoice: { number, issuedAt }` holds the document's own number and date: for a
credit note, the credit-note number and date.

`InvoiceModel` gains these fields:

- `kind: "invoice" | "credit_note"`
- `docLabel`: "Tax invoice" or "Credit note"
- `numberLabel`: "INVOICE NO." or "CREDIT NOTE NO."
- `dateLabel`: "INVOICE DATE" or "DATE"
- `reference: { label: "AGAINST INVOICE"; value: string } | null`, for example `"AXS/26-27/0012 · 7 Oct 2026"`
- `extraNotes: string[]`

For credit notes:

- `title` is `` `Credit note ${no}` ``.
- `totalLabel` is "Total credited".
- `extraNotes` holds: `` `Issued to cancel tax invoice ${orig} dated ${date} in full because the billing details were corrected.` ``
  When `replacedBy` is set, add `` `Replaced by tax invoice ${replacedBy}.` ``

For an invoice with `replaces`, `extraNotes` holds:
`` `This invoice replaces ${invoiceNo}, cancelled by credit note ${creditNoteNo} (billing details corrected).` ``

`invoiceFileName` becomes `documentFileName(kind, number)`, giving `"Invoice-AXS-26-27-0012.pdf"` or
`"CreditNote-AXC-26-27-0004.pdf"`. Keep `invoiceFileName` as a wrapper.

`lib/invoice/pdf.tsx` replaces its hard-coded strings with the model fields:

- the title "Tax invoice" becomes `model.docLabel` (line 282). The subtitle stays "Original for recipient".
- the `INVOICE NO.` and `INVOICE DATE` meta labels come from `numberLabel` and `dateLabel`. When `reference` is set,
  a fifth meta cell is added.
- the footer reads `` `${seller} · ${docLabel} ${number}` ``.
- the Document `title` is `` `${docLabel} ${number}` ``.
- `Notes` appends `extraNotes`. For credit notes the "computer-generated" line reads "credit note" instead of "invoice".

`lib/invoice/load.ts`:

- `loadInvoiceModel` looks up `InvoiceCorrection` where `newInvoiceNo === invoice.number`. If one exists, it passes
  `document: { kind: "invoice", replaces: { invoiceNo: c.originalInvoiceNo, creditNoteNo: c.creditNoteNo } }`.
- New `loadCreditNoteModel(db, orderId, correctionId)` returns null unless the correction belongs to that order. It
  builds the model as follows:
  - billing from `originalBilling`, seller from `seller`, sac from `sac`
  - totals from the correction's amount columns, lines from the order items (the amounts never change)
  - `invoice` set to the credit-note number and `issuedAt`
  - `document` set to `{ kind: "credit_note", against: { number: originalInvoiceNo, issuedAt: originalIssuedAt }, replacedBy: newInvoiceNo }`
  - status: the order's status (always in `INVOICE_STATUSES` after a correction)

---

# PART A: Customers (Admin > Customers & business accounts)

Roles: Owner, Administrator, Support. Finance keeps read access (`customers.view`) and gets none of these actions.

## A1. Mark email as verified

`POST /api/admin/customers/[id]/verify-email`. `[id]` is the BusinessAccount id.

| | |
|---|---|
| Permission | `customers.verify_email` (adminRoute), DESTRUCTIVE key `customers.verify_email` |
| Body | `z.strictObject({ ...destructiveFields, userId: z.string().regex(ADMIN_ID_RE).optional() })` |
| Service | `markCustomerEmailVerified(accountId, userId, { staff, actor, input, now?, client? })` in `lib/admin/customers/records.ts` |
| Rate limit | `adminCustomerWrite(staff.id)` |
| 200 | `{ userId, email, changed: boolean, claimedOrders: number }` |
| Errors | 422 `reason_required` / `reason_too_long` (checked **first**, before any lookup), 404 Customer, 409 `no_owner`, 422 `userId`, 409 `member_invited` ("This person hasn’t accepted their team invitation yet."), 409 `not_customer` ("Staff accounts can’t be changed here.") |
| Audit | One row, action "Marked email as verified", target user.email, targetType `customer`, targetId accountId, reason, detail `` `${legalName}${claimed ? ` · ${n} guest orders moved to this account` : ""}` `` |

Steps:

1. Run `runDestructive("customers.verify_email", { selfAudited: true, ... })`. It checks the permission and the reason,
   then opens one transaction.
2. Find the member: the `userId` given, or the first ACTIVE OWNER. The member must be `ACTIVE`, and `user.kind` must be
   `CUSTOMER`.
3. `tx.user.updateMany({ where: { id, emailVerifiedAt: null }, data: { emailVerifiedAt: now } })`. A count of 0 means
   the email was already verified: return `changed: false` and write **no** audit row. That makes the action
   idempotent.
4. Void open verification codes with `invalidateUserTokens(tx, user.id, ["EMAIL_VERIFY"], now)`.
5. Run `claimGuestOrders(tx, { ...user, emailVerifiedAt: now })` (D8).
6. Write the audit row. Sessions are left alone: the customer's next request reads the user fresh.

## A2. Create customer

`POST /api/admin/customers`, added to the existing `route.ts` next to `GET`.

| | |
|---|---|
| Permission | `customers.create`. Ticking `emailVerified: true` also needs `customers.verify_email` (`ctx.requirePerm`, 403). |
| Body | `customerCreateBody` (below) |
| Service | `createCustomer(input, { staff, actor, now?, client? })` in `lib/admin/customers/records.ts` |
| Rate limit | `adminCustomerCreate(staff.id)` |
| 201 | `{ accountId, userId, email, emailVerified, claimedOrders, setPassword: { url, expiresAt }, emailSent }` |
| Errors | 422 `validation_failed` (fieldErrors), 422 `reason_required`, 409 `email_taken` with `details: { accountId? }` |
| Audit | "Created customer", target email, targetType `customer`, targetId accountId, reason, detail `` `${legalName} · fields: name, email, phone, gstin, address… · email marked verified` `` (field names only, never the link) |

Body (`lib/admin/customers/schemas.ts`, pure):

```ts
export const customerCreateBody = z.strictObject({
  name: personNameSchema,
  email: makeEmailSchema(CUSTOMER_FORM_ERRORS.email),        // trim + lower-case, like registration
  phone: phoneFieldSchema.optional(),                          // Indian mobile; "" -> null
  legalName: optionalLine(BUSINESS_NAME_MAX, PORTAL_ERRORS.legalNameTooLong).optional(), // empty -> person's name
  gstin: gstinFieldSchema.optional(),
  address: optionalLine(BILLING_MAX.address, PORTAL_ERRORS.addressTooLong).optional(),
  city: optionalLine(BILLING_MAX.city, PORTAL_ERRORS.cityTooLong).optional(),
  state: stateFieldSchema.optional(),
  pin: pinFieldSchema.optional(),
  emailVerified: z.boolean().optional(),
  reason: z.string().max(2000).nullish(),
}).superRefine(/* billingDetailsIssue({ gstin, state }) -> issue on gstin or state */);
```

### A2.1 Steps

1. Call `requireReason(input.reason)`. If `emailVerified` is true, call `ctx.requirePerm("customers.verify_email")`.
2. Pre-check the address with `db.user.findUnique({ where: { email } })`:
   - **Staff user** → 409 `email_taken` "This email belongs to a staff account."
   - **Customer who is not a placeholder** (see A2.4) → 409 `email_taken` "A customer with this email already exists."
     with `details.accountId` set to their first ACTIVE OWNER account, or omitted.
   - **Placeholder from a team invite** → take it over inside the transaction. Its pending invitations stay.
3. Generate the secret with `newOpaqueSecret()` (outside the transaction, pure).
4. In one transaction:
   1. Create the user `{ kind: CUSTOMER, email, name, phone, passwordHash: null, createdByStaffId: staff.id, emailVerifiedAt: emailVerified ? now : null }`.
      For a placeholder takeover, use `updateMany where { email, ...PLACEHOLDER_USER_WHERE }` with the same data. A
      count of 0 means a race: answer 409.
   2. Create the account `businessAccount.create { legalName: legalName ?? name, gstin, address, city, state, pin }`.
   3. Create `accountMember.create { role: OWNER, status: ACTIVE, invitedAt: null }`. This is the user's own account,
      so guest orders are claimed into it.
   4. If `emailVerified`: run `claimGuestOrders(tx, user)`.
   5. Issue the link. Void open `PASSWORD_RESET` tokens for the email, then create
      `authToken.create { type: PASSWORD_RESET, userId, email, codeHash: hash, expiresAt: now + SET_PASSWORD_TTL_MS, meta: { purpose: "set_password" } }`.
   6. Write `recordAccountActivity` with actor `{ id: null, name: "Axiomatic team" }`, action "Created account",
      target legalName, kind `team`.
   7. Write the audit row.
5. A unique violation on `User.email` (P2002) becomes 409 `email_taken`.
6. After commit, send `sendAuthEmail({ to: email, templateId: "set_password", vars: { customer_name: greetingName(name), set_password_url: resetUrl(`${tokenId}.${secret}`), expires_in: "7 days", business_name: legalName } })`.
   It never throws. Return `emailSent: ok`.
7. Return the URL once in the 201 body. `adminRoute` adds `no-store`. **Never** log or audit the URL. Log
   `admin_customer_created { userId, accountId, emailSent }`.

### A2.2 What the link does

The link is a normal reset token: single use, a 256-bit secret, SHA-256 stored, and bound to the email.

`lib/auth/flows/reset-password.ts` changes in two places:

- `findResetToken` adds one check. When `metaString(token.meta, "purpose") === "set_password"` and the user already
  has a password, it throws `resetInvalidError()` (defence in depth).
- `inspectResetToken` returns `{ email, mode: token.user.passwordHash === null ? "set" : "reset" }`. `GET
  /api/auth/reset-password` returns the same fields. Document this in `docs/api.md`.

`resetPassword` is unchanged. It sets the password, bumps the epoch, voids `PASSWORD_RESET` and `LOGIN_OTP` tokens
and revokes sessions. Verification is unchanged (D7).

The page `app/(auth)/reset/page.tsx` and `components/auth/reset-form.tsx` take a `mode` prop. New copy in
`components/auth/copy.ts`, under `AUTH_COPY.setPassword`:

- title "Set your password"
- subtitle `For ${email}. Choose a password to sign in to Axiomatic.`
- cta "Set password"
- password label "Password"

The page metadata title becomes "Choose your password".

`AUTH_COPY.reset.invalidSubtitle` becomes "Links work once and expire after a while. Ask for a new one below." The
current text promises 30 minutes, which is wrong for 7-day links. The button keeps "Request a new link" (→ /forgot).

### A2.3 `/forgot` for staff-created customers (D6)

In `requestPasswordReset` (`lib/auth/flows/forgot-password.ts:43`), eligibility becomes:

```ts
const eligible = user && canSignIn(user) && (user.passwordHash !== null || (user.kind === "CUSTOMER" && user.createdByStaffId !== null));
```

A staff-created user without a password gets a 30-minute `PASSWORD_RESET` token with `meta: { purpose: "set_password" }`
through the `set_password` template, with `expires_in: "30 minutes"`. Everyone else keeps the `password_reset`
template. The response shape and timing behaviour do not change. Sample users and invite placeholders stay locked.
Update the module comment.

### A2.4 Placeholder takeover fix (security)

Today `PLACEHOLDER_USER_WHERE` is `{ kind: CUSTOMER, passwordHash: null, emailVerifiedAt: null }`. A staff-created,
unverified customer without a password matches it. That means `/register` (`register.ts:52,59`) or checkout "Create
an account" (`create-order.ts:98`, `account.ts:31`) for that address would set a password on the row. The registrant
would become OWNER of the account staff created.

Fix in `lib/auth/flows/common.ts`:

```ts
export const PLACEHOLDER_USER_WHERE = { kind: "CUSTOMER", passwordHash: null, emailVerifiedAt: null, createdByStaffId: null } as const satisfies Prisma.UserWhereInput;
export function isPlaceholderUser(user: Pick<User, "kind" | "passwordHash" | "emailVerifiedAt" | "createdByStaffId">): boolean
```

- Add `createdByStaffId: true` to the selects in `register.ts:52` and `create-order.ts:98`.
- `takeOverPlaceholderUser` and `dropUnusedPlaceholder` (`team.ts:318`) pick the change up through the shared
  `where`.
- Registering a staff-created address now answers 409 `email_taken`. The customer then uses the set-password link,
  or `/forgot`.

## A3. Edit customer

`PATCH /api/admin/customers/[id]`, added to the existing `[id]/route.ts` next to `GET`.

| | |
|---|---|
| Permission | `customers.edit`. `emailVerified: true` with a new email also needs `customers.verify_email` (403). |
| Body | `customerPatchBody`: every field optional, the same field schemas as create (person: `name`, `phone`, `email`; business: `legalName` via `legalNameSchema`, `gstin`, `address`, `city`, `state`, `pin`), plus `emailVerified?: boolean` and `reason`. At least one field other than `reason` and `emailVerified` (422 `formErrors` "Change a field before saving."). Person fields target the account's first ACTIVE OWNER. |
| Service | `updateCustomer(accountId, input, { staff, actor, now?, client? })` |
| Rate limit | `adminCustomerWrite(staff.id)` |
| 200 | `{ customer: AdminCustomerDetail, changed: boolean, signedOut: number }` |
| Errors | 422 `reason_required` (always, D4), 422 `validation_failed` (field errors, GSTIN/state rule on the merged business details), 422 `emailVerified` "Tick this only when you change the email.", 404 Customer, 409 `no_owner` (person fields without an owner), 409 `not_customer`, 409 `email_taken` "This email is already used by another account." |
| Audit | One row "Updated customer", target the (new) email, targetType `customer`, targetId accountId, reason, detail `` `Changed: name, phone, email, gstin` `` plus, for an email change, `` ` · email was ${emailHint(old)} · signed out of ${n} sessions · ${verified ? "verified by staff" : "verification cleared"}` ``. No-op: `changed: false`, no audit row, nothing written. |

Steps, all in one transaction:

1. `requireReason`.
2. Lock the account with `SELECT ... FROM "BusinessAccount" ... FOR UPDATE`. Load the owner member and user.
3. Business: `mergeBillingDetails(current, patch)`, then `billingDetailsIssue` → 422 on the field. Compare with
   `DETAIL_KEYS` to find the changes. Write the update and `recordAccountActivity` "Updated billing details" with actor
   "Axiomatic team".
4. Person: name and phone go through `user.update`.
5. Email change, when the new address differs from the current one. This is D9:
   1. `user.update { email, emailVerifiedAt: emailVerified ? now : null, securityEpoch: { increment: 1 } }`.
      P2002 → 409 `email_taken`.
   2. `revokeAllSessions(tx, user.id, { now })`.
   3. `tx.authToken.updateMany({ where: { userId, usedAt: null, type: { in: ["EMAIL_VERIFY", "PASSWORD_RESET", "LOGIN_OTP"] } }, data: { usedAt: now } })`.
      Tokens bound to the old email would fail the email check anyway.
   4. If verified: `claimGuestOrders(tx, user)` for the **new** address.
   5. `enqueueEmail(tx, { to: oldEmail, templateId: "account_email_changed", vars: { customer_name, new_email_hint: emailHint(newEmail) }, dedupeKey: `account_email_changed:${userId}:${epoch}` })`.
   6. After commit, call `kickEmailDispatch()`.
6. What does not change:
   - `Order.email` snapshots and guest orders under the old address. Order links signed for the old email keep working
     for their orders.
   - A set-password link that was not yet used dies (it was voided in step 5.3). Staff create a new one.
7. A user can belong to several accounts. Person changes apply everywhere, and the form says so.

`tests/db/security-epoch.test.ts` gets a case for this. Add "a staff email change" to the epoch events in
`docs/security.md`.

## A4. Set-password links and the existing email actions

### A4.1 New route

`POST /api/admin/customers/[id]/set-password-link`

| | |
|---|---|
| Permission | `customers.manage`, DESTRUCTIVE key `customers.set_password_link` |
| Body | `z.strictObject({ ...destructiveFields, userId: … .optional() })` |
| Service | `createSetPasswordLink(accountId, userId, ctx)` in `lib/admin/customers/actions.ts` |
| Rate limits | `adminCustomerWrite(staff.id)` (route) and `attempt(adminSetPasswordLink(user.id))` (service, after the target checks) |
| 201 | `{ userId, email, url, expiresAt, emailSent }`: the link is shown once |
| Errors | 422 reason (first), 404, 409 `no_owner`, 422 `userId`, 409 `member_invited` (INVITED placeholder: "This person hasn’t accepted their team invitation yet. Ask the account owner to resend it."), 409 `has_password` ("This person already has a password. Send a password reset instead."), 409 `not_customer`, 429 |
| Audit | "Created set-password link", target email, targetType `customer`, targetId accountId, reason, detail `` `${legalName} · expires ${date}` `` (never the link) |

Steps:

1. Inside `runDestructive`, void open `PASSWORD_RESET` tokens for the email.
2. Create a `PASSWORD_RESET` token with meta `{ purpose: "set_password" }` and a 7-day expiry. Write the audit row.
3. After commit, `sendAuthEmail("set_password", …)`.

### A4.2 Existing actions

- `targetMember` (`lib/admin/customers/actions.ts:38-49`) keeps 409 `no_password` for **both** existing actions when
  there is no password. That keeps `tests/db/admin-customers-routes.test.ts:184-196` valid.
- Its message is split:
  - INVITED placeholder: `noPassword` as today.
  - ACTIVE staff-created member: `useSetPasswordLink` "This person hasn’t set a password yet. Create a set-password
    link instead."
- The password-reset route and its "link never returned" promise are unchanged. Only the new route returns a link,
  and only for people without a password.

## A5. Data and queries

`lib/admin/customers/model.ts`:

- `AdminCustomerMember` gains `createdByStaff: boolean` and `canSetPassword: boolean` (ACTIVE, CUSTOMER, no password).
- `AdminCustomerDetail.owner` gains `createdByStaff`.
- `AdminCustomerLicense` gains `productId` and `planType`. The order form uses them to pick target licenses.

`lib/admin/customers/queries.ts` `getAdminCustomerDetail` selects `createdByStaffId` and `plan { productId, type }`.
It never returns the password hash.

`lib/admin/audit/model.ts`:

- `TARGET_MODULES` gains `customer: "customers"`.
- `AuditTargetModule` gains `"customers"`, so customer audit rows open the customer drawer.

## A6. UI (Admin > Customers)

Use the existing patterns: `AdminModulePage` actions, `AdminDrawer` with the `edit` slot, `DestructiveAction`,
`Field size="sm"`, `NativeSelect` for states, `Checkbox`, `formErrorsFrom`, `adminToast` and design tokens only. Each
field's error is tied to it through `Field`. Focus moves to the first error (`FormErrorSummary`), or to the link panel
after success. One column below 420px, two columns from `min-[26.25rem]`. Works at 360px.

### A6.1 Page header

`app/admin/customers/page.tsx` gets `actions={<Suspense><NewCustomerAction /></Suspense>}`.

`NewCustomerAction` is an `AdminAction perm="customers.create" variant="primary" icon="person_add"` with the text
"New customer". It opens `?new=1`. The pattern is `components/admin/coupons/new-coupon.tsx`.

### A6.2 New customer drawer

`components/admin/customers/new-customer.tsx` renders `NewCustomerDrawer`, open when `?new=1` and no `?id=`.

- Title "New customer". Subtitle "They get a link to set their own password."
- Fieldset "Person":
  - "Full name" (required)
  - "Email" (required), hint "They sign in with this address."
  - "Mobile" (optional), hint "10-digit Indian mobile number."
- Fieldset "Business":
  - "Business or legal name" (optional), hint "Leave empty to use the person’s name."
  - "GSTIN" (optional, mono)
  - "Address", "City", "State" (`NativeSelect`, placeholder "Choose a state"), "PIN code"
  - Hint under GSTIN: "Needs the state it’s registered in."
- Checkbox "Email already verified":
  - Hint "Tick only if you’ve confirmed they own this address. Guest purchases made with it move into this account."
  - Disabled with the `requiresLabel` tooltip when the role lacks `customers.verify_email`.
- Textarea "Reason (saved to the audit log)", required.
- Submit `DrawerSubmit` "Create customer".
- 409 `email_taken` shows on the Email field. When `details.accountId` is set, an inline link "Open customer" goes to
  `adminCustomerHref`.
- On success, the form is replaced by a one-time link panel (`Alert tone="success"`, `role="status"`, focused):
  - Heading "Customer created".
  - Read-only `Input size="sm" mono readOnly` labelled "Set-password link (shown once)".
  - `AdminAction icon="content_copy"` "Copy link". It uses `navigator.clipboard.writeText` with the fallback toast
    "Couldn’t copy the link. Select it and copy it instead."
  - Text when `emailSent`: `Send this link to ${name} if they can’t find our email. It works once and expires on ${date}.`
  - Text when not sent: `We couldn’t email it, so send this link to ${name} yourself. It works once and expires on ${date}.`
  - Warning line: "Anyone with this link can set the password. Share it only with the customer."
  - Buttons "Open customer" (`router.replace` `?id=<accountId>`) and "Add another".
  - The link lives in component state only. It is cleared on close and never written to the URL, storage or a toast.

### A6.3 Customer drawer, edit card

`components/admin/customers/customer-edit-form.tsx` uses `edit={{ title: "Edit details", readOnly: !useCan("customers.edit"), readOnlyNote: "Your role can’t edit customers.", form }}`.

- Fields: person (name, email, mobile) and business (name, GSTIN, address, city, state, PIN), prefilled from the
  detail.
- Note above the person fields: "Name, email and mobile belong to the person and change in every account they’re in."
- When the email differs from the stored one, these appear:
  - Checkbox "New email already verified" (needs `customers.verify_email`).
  - `Alert tone="warning"`: `Changing the email signs ${name} out everywhere and stops their old links. We’ll tell the old address.`
- "Reason (saved to the audit log)" is required.
- Submit "Save changes". Send only the changed fields, as `couponPatch` does.
- Toasts: "Customer updated", "No changes to save", and `Customer updated · signed out of ${n} sessions`.
- Call `detail.reload()` and `router.refresh()`.

### A6.4 Customer drawer footer

The current two buttons become four. Each one is shown or disabled by rule:

- "Resend verification" (`customers.manage`): unchanged.
- "Mark email as verified": `DestructiveAction actionKey="customers.verify_email" targetId={owner.email}`.
  - Disabled with "Email already verified" when verified, and with "No active owner" when there is no owner.
  - Consequence: `Confirms that ${email} belongs to ${name}. Their pending verification code stops working, and guest purchases made with this email move into ${legalName}.`
  - Success: "Email marked as verified". Then reload.
- When `owner.hasPassword`, "Send password reset" is unchanged.
- Otherwise, when `owner.canSetPassword`, "Create set-password link": `DestructiveAction actionKey="customers.set_password_link"`.
  - Consequence: `Creates a link ${name} can use once to choose a password. It expires in 7 days and you’ll see it only once. We also email it to ${email}.`
  - On success it opens a `Dialog` titled "Set-password link". The body is the same one-time link panel as A6.2.

## A7. Tests (PART A)

Unit, in `tests/unit/admin-customers-records-model.test.ts` (new):

- `customerCreateBody`: email trim and lower-case; invalid email; phone normalisation; GSTIN normalisation; GSTIN
  without a state; GSTIN from another state; empty legal name → null; strict keys.
- `customerPatchBody`: nothing to update; `emailVerified` without an email.
- The `changedCustomerFields` helper: names only, and a no-op.
- Reset copy selection by `mode`.

DB, in `tests/db/admin-customers-records.test.ts` (new; the mail mock and fixture pattern of
`admin-customers-routes.test.ts`):

1. **Roles:** create, PATCH, verify-email and set-password-link are 201/200 for Owner, Administrator and Support; 403
   for Finance and customers; 401 signed out; 403 without CSRF. The registry matrix also covers this. Add
   EXPLICIT_CASES "Finance cannot create customers" and "Support can mark emails verified".
2. **Create:**
   - The account, an OWNER ACTIVE membership with `invitedAt` null, and the user with `passwordHash` null and
     `createdByStaffId` set.
   - The response has a `/reset?token=` URL.
   - The token row is `PASSWORD_RESET` with `meta.purpose = set_password` and a 7-day expiry, and its `codeHash` is not
     the secret.
   - The email is captured with `set_password_url`.
   - The audit row has no `token=` and no secret in any column.
   - Logs do not contain the token (spy on `log`).
3. **Create, duplicate email:** an existing customer → 409 `email_taken` with `details.accountId`; a staff email →
   409; differences in case and whitespace → 409.
4. **Create over a team-invite placeholder:** the user is taken over, the pending invite stays, and no 409.
5. **Create with "verified":** `emailVerifiedAt` set, guest orders under that email claimed into the new account, and
   403 for a role without `customers.verify_email`. (Same role sets, so check this through a unit test of the guard,
   or by calling the service with a forged role.)
6. **Email failure** (mock returns `{ ok: false }`): still 201, `emailSent: false`, the link is returned.
7. **Placeholder fix:** `registerUser` with a staff-created unverified address → 409 `email_taken`, and the user row
   is unchanged. Checkout `createAccount` gives the same 409.
8. **Set-password completion:**
   - `resetPassword` with the link sets the password and bumps the epoch.
   - A second use → `token_invalid`.
   - `inspectResetToken` → `mode: "set"` before and `"reset"` for a normal reset.
   - A `set_password` token for a user who now has a password → invalid.
9. **/forgot:** a staff-created user without a password gets a `set_password` email with a 30-minute token; a sample
   or placeholder user still gets nothing.
10. **Edit:**
    - 422 `reason_required`.
    - Name and phone only: no epoch bump and no session revoke.
    - Business GSTIN/state rule → 422.
    - Email change: epoch +1, every session revoked, open EMAIL_VERIFY / PASSWORD_RESET / LOGIN_OTP tokens used,
      `emailVerifiedAt` null, an outbox `account_email_changed` row to the old address.
    - With `emailVerified` set: verified, and guest orders of the new address claimed.
    - A duplicate → 409.
    - A no-op → `changed: false` and no audit row.
    - The audit detail lists field names and never the full old address.
11. **Verify:**
    - 422 reason before `already_verified` (the seeded verified customer).
    - Verifies once; a second call → 200 `changed: false` and no second audit row.
    - EMAIL_VERIFY tokens used; guest orders claimed.
    - INVITED member → 409 `member_invited`.
12. **Set-password link:**
    - 409 `has_password` for a customer with a password.
    - 409 `member_invited` for an invite placeholder.
    - A 6th link within an hour → 429.
    - Older open links voided.
13. **Existing routes:** password reset for a staff-created customer without a password → 409 `no_password` with the
    `useSetPasswordLink` message. The INVITED case is unchanged.

Existing tests to update only where behaviour changed:

- `tests/db/security-epoch.test.ts`: new case.
- Auth register and checkout tests: placeholder selects.
- `tests/unit/email-*`: the new template ids.

---

# PART B: Orders (Admin > Orders & payments)

Roles: Owner and Finance. Administrator and Support keep the current read access and the "Resend invoice" action.

## B1. Live quote

`POST /api/admin/orders/quote`. It is read-only, has no audit row, and still needs CSRF because it is a POST.

| | |
|---|---|
| Permission | `orders.create`. With `orderId`, also `orders.edit` (`ctx.requirePerm`). |
| Body | `orderQuoteBody = z.strictObject({ accountId: ADMIN_ID.optional(), orderId: z.string().refine(isOrderIdShape).optional(), items: z.array(checkoutItemSchema).max(CHECKOUT_MAX_LINES), couponCode: couponCodeSchema, billingState: z.enum(INDIAN_STATES).nullish() })`. Exactly one of `accountId` and `orderId` is required (422 `formErrors`). |
| Service | `quoteAdminOrder(db, input, now)`. It resolves the buyer with `accountPricingBuyer(accountId ?? order.accountId)` and calls `priceCart(db, { items, couponCode, billingState, excludeOrderId: orderId }, buyer, now)`. |
| Rate limit | `adminOrderQuote(staff.id)` |
| 200 | `{ quote: QuoteDto }` (`toQuoteDto`: lines, totals, GST split, `intraState`, coupon result, `issues`) |
| Errors | 404 Customer or Order, 422 |

## B2. Create order: send a payment link

`POST /api/admin/orders`, a new `route.ts` next to `GET`.

| | |
|---|---|
| Permission | `orders.create` |
| Body | `orderCreateBody = z.strictObject({ requestId: z.uuid(), accountId: ADMIN_ID, items: itemsSchema.min(1), couponCode: couponCodeSchema, billing: billingSchema, reason: z.string().max(2000).nullish() })` |
| Service | `createPaymentLinkOrder(input, { staff, actor, now?, client? })` in `lib/admin/orders/create.ts` |
| Rate limit | `adminOrderCreate(staff.id)` |
| 201 | `{ orderId, status: "awaiting_payment", totalPaise, paymentUrl, paymentUrlExpiresAt, emailQueued: true, replayed: false }`. A replay answers 200 with `replayed: true` and a freshly signed URL. |
| Errors | 422 `reason_required`, 404 Customer, 422 `cart_invalid` (`details.issues`), 422 `couponCode`, 422 `items`, 422 `zero_total`, 409 `duplicate_request` (`requestId` used by another staff member) |
| Audit | "Created order", target orderId, targetType `order`, targetId orderId, reason, detail `` `Payment link · ${formatINR(total)} · ${n} items${coupon ? ` · coupon ${code}` : ""} · for ${legalName}` `` |

Steps:

1. `requireReason`.
2. Idempotency: `order.findUnique({ where: { staffRequestId } })`. If the same staff member created it, return it. If
   someone else did, answer 409.
3. Load the account: 404 if missing.
4. `priceCart(db, { items, couponCode, billingState: billing.state }, accountPricingBuyer(accountId), now)`, then
   `assertPricedCart(priced)`.
5. `nextOrderId` in its own short transaction. Order ids may have gaps.
6. One transaction:
   1. If there is a coupon: `lockCoupon`, then `couponAvailability(tx, code, { now })`. Not available → 422 on
      `couponCode`.
   2. `tx.order.create({ data: orderCreateData({ id, accountId, placedByUserId: null, billing: billingSnapshot(billing), quote, couponCode, now, terms: null, staff: { createdByStaffId, staffRequestId: requestId } }) })`.
      There is **no Payment row** (D10).
   3. `enqueueEmail(tx, { to: billing.email, templateId: "order_payment_link", vars: { customer_name, order_id, order_url: orderUrl(order, now), total }, dedupeKey: `order_payment_link:${orderId}` })`.
   4. Write the audit row.
7. P2002 on `staffRequestId` → re-read and return the existing order (`replayed`).
8. After commit, call `kickEmailDispatch()`.
9. The `paymentUrl` is `orderUrl(order, now)`: the tokenised `/orders/<id>?t=…`, valid for 30 days and bound to
   `order.email`.

Why `placedByUserId: null`: the portal would otherwise say "by <owner>" for an order the owner did not place. Access
for members comes from `accountId` (`invoices.view`, `purchases`). The verified owner whose email matches the order
gets the one-time key delivery through the existing `claimedByEmailOwner` rule.

### B2.1 How the customer pays

The order page offers "Pay now". `POST /api/checkout/orders/:id/retry` changes in three ways (`lib/checkout/payment-attempt.ts`):

- **Terms (D11).** New body schema `retryRequestSchema = orderActionRequestSchema.extend({ acceptTerms: z.literal(true).optional() })`.
  - When `order.createdByStaffId !== null && order.termsAcceptedAt === null`, the request must carry
    `acceptTerms: true`. Otherwise 422 `{ acceptTerms: CHECKOUT_ERRORS.acceptTerms }`.
  - Acceptance is recorded with `tx.order.updateMany({ where: { id, termsAcceptedAt: null }, data: { termsAcceptedAt: now, termsVersion: CHECKOUT_TERMS_VERSION } })`.
    It runs in the attempt transaction, and also before a reopen.
- **Staff cancel (D15).** When `order.canceledByStaffAt !== null` → 409 `not_retryable`. This is checked before the
  provider call and again inside the transaction.
- **Stale reopen (D14).** The reopen condition gains `latest.amountPaise === order.totalPaise`.

With zero payments, `latest` is null, so the existing code creates a fresh provider order at `order.totalPaise`.
Nothing else changes. The license is issued **only** by the verified webhook (unchanged rule).

Known limit, documented: a payment-link order holds no coupon slot until the first "Pay now", because holds count
only through `Payment.createdAt`. If the coupon is used up or expires first, payment answers 409
`order_unavailable`. Staff then edit the order (B5) or create a new one.

## B3. Create order and record an offline payment

`POST /api/admin/orders/offline`, a new folder `app/api/admin/orders/offline/route.ts`. The static segment wins over
`[id]`, and order ids look like `AX-n`, so they never collide.

| | |
|---|---|
| Permission | `payments.record_offline` |
| Body | `offlineOrderBody = orderCreateBody.extend({ method: z.enum(["cash", "upi", "bank_transfer", "cheque", "other"]), reference: z.string().trim().max(64).regex(/^[A-Za-z0-9 /._-]*$/).nullish(), receivedOn: z.iso.date(), amountPaise: z.number().int().positive() })`. A `superRefine` makes `reference` required for upi, bank_transfer and cheque: "Enter the UTR or reference number." / "Enter the cheque number." |
| Service | `createOfflinePaidOrder(input, { staff, actor, now?, client? })` in `lib/admin/orders/offline.ts` |
| Rate limit | `adminOrderCreate(staff.id)` |
| 201 | `{ orderId, status: "paid", invoiceNumber, licensesIssued, licensesUpdated, totalPaise, replayed: false }`. A replay answers 200 with `replayed: true` and the stored invoice number. |
| Errors | 422 `reason_required`; 422 `receivedOn` ("Enter a date in the last 180 days, not in the future." checked in IST); 422 `amountPaise` (`` `The amount must equal the order total, ${formatINR(total, { exact: true })}. Partial payments can’t be recorded.` ``); the B2 errors; 409 `fulfilment_failed` (`` `We couldn’t issue this order (${code}). Nothing was saved. Check the items and try again.` ``); 409 `duplicate_request` |
| Audit | "Recorded offline payment", target orderId, targetType `order`, reason, detail `` `${methodLabel}${reference ? ` · ref ${reference}` : ""} · ${formatINR(total, { exact: true })} received ${formatDateIST(receivedAt)} · Invoice ${no} · ${n} licenses issued, ${m} updated · for ${legalName}` `` |

Steps:

1. `requireReason`, then validate the received date (IST).
2. Idempotency pre-check, as in B2.
3. Price as in B2. Check that `amountPaise === quote.totalPaise`, else 422.
4. `nextOrderId` in its own short transaction.
5. One transaction (`{ maxWait: 10_000, timeout: 30_000 }`):
   1. Coupon: `lockCoupon` and `couponAvailability`.
   2. `tx.order.create(orderCreateData({ ..., terms: null, staff }))` with status `AWAITING_PAYMENT`.
   3. `tx.payment.create({ orderId, provider: "offline", providerOrderId: offlineProviderOrderId(orderId), providerPaymentId: null, method: OFFLINE_METHOD_LABELS[method], amountPaise: total, status: CAPTURED, capturedAt: now, reference, receivedAt: startOfDayIST(receivedOn), recordedById: staff.id })`.
   4. `SELECT "id" FROM "Order" WHERE "id" = $1 FOR UPDATE`, then re-read the order with `placedBy`.
   5. `fulfilPaidOrder(tx, { order, paidAt: now, now })` (§3.4). This is the webhook's code: license issuance with key
      sealing, terms snapshots, the late invoice number, the coupon redemption, activity, notifications, and the
      outbox `order_confirmation` and `license_issued` emails.
   6. Staff audit row.
6. Errors in the transaction:
   - `FulfilmentError`, `LicenseTermsError` or `DocumentSeriesExhaustedError` → the transaction rolls back, then 409
     `fulfilment_failed` with `fulfilmentErrorCode(error)`. Nothing is stored. Unlike the webhook, no money was taken
     through us, so there is no REVIEW state.
   - P2002 on `Order.staffRequestId` (a concurrent double submit) → re-read and return the order the first request
     committed (`replayed: true`).
7. After commit, call `kickEmailDispatch()`.

Effects on existing code, all verified:

- `pickPayingPayment` picks the single capture.
- `detail.ts:167` marks duplicates only when `providerPaymentId` is set.
- Reconciliation picks only rows for the configured provider key, so `"offline"` is never reconciled.
- `recordPaymentReturn` skips non-provider keys.

Admin labels:

- `ORDER_PROVIDER_FILTERS = [...PAYMENT_PROVIDER_KEYS, "offline"] as const`.
- `PROVIDER_LABELS` gains `offline: "Offline"`, typed over `OrderProviderFilter`.
- `ORDER_METHOD_FILTERS` gains `cash`, `bank_transfer`, `cheque` and `other`, with the labels from §1.2. These filter
  `Payment.method`.

Refunds (D20):

- `detail.ts` sets `refund.allowed = false` when the paying payment has `provider === "offline"`, and adds
  `refund.unavailableReason = "Refunds of offline payments aren’t available in the console yet."`.
- `issueOrderRefund` already answers 409 `not_refundable` for such a payment. Keep it.

## B4. Re-share a payment link

`POST /api/admin/orders/[id]/payment-link`

| | |
|---|---|
| Permission | `orders.create` |
| Body | `z.strictObject({ send: z.boolean().optional() })` |
| Rate limit | `adminOrderWrite(staff.id)` |
| 200 | `{ url, expiresAt, emailQueued }` |
| Errors | 404, 409 `not_payable` ("Only unpaid orders that weren’t cancelled by our team can be paid.") for any status other than AWAITING_PAYMENT, FAILED or CANCELED, or when `canceledByStaffAt` is set |
| Audit | "Shared payment link", target orderId, detail `"Copied"` or `` `Emailed to ${email}` ``. No reason (D4). |

With `send: true`, enqueue `order_payment_link` with dedupe key `` `order_payment_link:${orderId}:${Date.now()}` ``.

## B5. Edit an unpaid order

`PATCH /api/admin/orders/[id]`, added to `[id]/route.ts` next to `GET`.

| | |
|---|---|
| Permission | `orders.edit` |
| Body | `orderPatchBody = z.strictObject({ items: itemsSchema.min(1).optional(), couponCode: couponCodeSchema.optional() /* null removes */, billing: billingSchema.optional(), reason })`, with at least one of items, couponCode, billing |
| Service | `updateUnpaidOrder(orderId, input, ctx)` in `lib/admin/orders/edit.ts` |
| Rate limit | `adminOrderWrite(staff.id)` |
| 200 | `{ order: AdminOrderDetail, changed, paymentUrl }`. The URL is freshly signed, because the email may have changed. |
| Errors | 422 reason; 404; 409 `not_editable` ("Only unpaid orders can be edited. Paid orders keep their amounts; refund or correct the billing instead."); 409 `payment_in_progress` ("A payment for this order is being confirmed, so it can’t change now."); 409 `order_canceled` (staff-cancelled); the pricing errors from B2 |
| Audit | "Updated order", detail `` `Changed: items, coupon, billing · total ${old} → ${new} · ${k} payment attempts closed` `` |

Rules (D14):

1. Price outside the transaction:
   - `items` defaults to the current items (`{ planId, qty: quantity, kind, targetLicenseId }`).
   - `couponCode` defaults to the current code.
   - `billing` defaults to the stored snapshot.
   - Then `priceCart(…, accountPricingBuyer(order.accountId), now)` with `excludeOrderId: id`, and `assertPricedCart`.
2. One transaction:
   1. `SELECT … FOR UPDATE` on the order.
   2. Re-check the status: AWAITING_PAYMENT, FAILED or CANCELED with `canceledByStaffAt` null.
   3. Re-check that no payment is `AUTHORIZED` or `CAPTURED`, and the order is not PENDING, CONFIRMING or REVIEW.
   4. Coupon: `lockCoupon` and `couponAvailability(tx, code, { now, excludeOrderId: id })`.
   5. `orderItem.deleteMany`, then create the new lines with the snapshot fields from the quote.
   6. `order.update`: totals, `couponCode`, `billing`, `email = billing.email`, `placeOfSupply = billing.state`,
      `status = AWAITING_PAYMENT`, `failReason = null`.
   7. `payment.updateMany({ where: { orderId, status: CREATED }, data: { status: CANCELED } })`.
   8. `payment.updateMany({ where: { orderId, supersededAt: null, status: { in: [CREATED, CANCELED, FAILED] } }, data: { supersededAt: now } })`.
   9. Write the audit row.
3. No-op: priced lines, coupon and billing all equal the stored values → `changed: false`, nothing written.
4. The account cannot change. To bill another customer, cancel this order and create a new one.

After an edit:

- The customer's next "Pay now" finds no `CREATED` attempt, so `retryPayment` creates a fresh provider order at the
  new total. That is the existing path.
- A capture of an old provider order still open in a browser lands in REVIEW, through either the amount mismatch or
  `supersededAt`.
- A changed email invalidates old order links, so the drawer shows the new link.
- `termsAcceptedAt` is kept. It records acceptance of the legal terms, not of the items.

## B6. Cancel an unpaid order

`POST /api/admin/orders/[id]/cancel`

| | |
|---|---|
| Permission | `orders.edit`, DESTRUCTIVE key `orders.cancel` |
| Body | `destructiveBodySchema` |
| Rate limit | `adminOrderWrite(staff.id)` |
| 200 | `{ status: "canceled", changed }` |
| Errors | 422 reason (first); 404; 409 `not_cancelable` ("Only unpaid orders can be cancelled. Refund paid orders instead."); 409 `payment_in_progress` |
| Audit | "Cancelled order" (`runDestructive`, `selfAudited`; no row when already staff-cancelled) |

Steps:

1. Lock the order. Apply the same status rules as B5.
2. `CREATED` payments → `CANCELED`, and set `supersededAt` on open attempts.
3. `order.update { status: CANCELED, canceledByStaffAt: now, failReason: "Cancelled by our team." }`.

The customer's own cancel (`lib/checkout/cancel.ts`) is unchanged.

## B7. Correct the billing details of a paid order

`POST /api/admin/orders/[id]/correct-billing`

| | |
|---|---|
| Permission | `invoices.correct` |
| Body | `billingCorrectionBody = z.strictObject({ billing: z.strictObject({ name, phone, business?, address, city, pin, gstin?, state?, email? }), reason })`. The field types are those of `billingSchema`. `state` and `email` are accepted only to give a clear refusal when they differ. |
| Service | `correctOrderBilling(orderId, input, ctx)` in `lib/admin/orders/correction.ts` |
| Rate limit | `adminOrderWrite(staff.id)` |
| 201 | `{ correction: { id, creditNoteNo, originalInvoiceNo, newInvoiceNo, issuedAt }, order: AdminOrderDetail }` |
| Errors | 422 reason; 404; 409 `not_correctable` ("Only paid orders with a tax invoice and no refunds can be corrected."); 422 `billing.state` ("The billing state sets the GST split, so it can’t change on a paid order. Refund the order and create a new one instead."); 422 `billing.email` ("The order email can’t change on a paid order."); 422 `billing.gstin` (a GSTIN registered in another state: `gstinStateMismatchMessage` plus " The billing state can’t change on a paid order."); 422 `nothing_changed` ("Change a billing detail before issuing a corrected invoice."); 409 `seller_state_changed` ("Your business state in Settings differs from the one on the original invoice, so the GST split could change. Contact your accountant."); 409 `invoice_series_exhausted` |
| Audit | "Corrected billing details", target orderId, targetType `order`, reason, detail `` `Changed: gstin, address · Credit note ${cn} cancels ${orig} · New invoice ${inv}` `` |

### B7.1 Validation (pure; `lib/admin/orders/correction-rules.ts`, unit tested)

```ts
export function correctedBilling(stored: BillingSnapshot, patch: BillingCorrectionInput):
  { ok: true; billing: BillingSnapshot; changedFields: string[] } | { ok: false; fieldErrors: Record<string, string> }
```

- If `patch.state` differs from `stored.state` → error. If `patch.email` differs from `stored.email` → error.
- Build `candidate = { ...stored, ...patch, state: stored.state, email: stored.email }` and run
  `billingSchema.safeParse(candidate)`. Errors are prefixed `billing.`.
- The `superRefine` in `billingSchema` refuses a GSTIN from another state. Since the state is fixed, that is the
  tax-change guard.
- `changedFields` compares the normalised `name`, `phone`, `business`, `address`, `city`, `pin` and `gstin`.

**Tax neutrality:**

- The place of supply (state) is fixed, the order amounts are never touched, and the seller state must match.
- Therefore `intraState` and the CGST/SGST/IGST split cannot change.
- Adding or removing a GSTIN in the same state changes only the B2B/B2C reporting, not the tax amounts. That is
  allowed: it is the usual reason for a correction.
- Unit test: `quote({ billingState: stored.state })` gives the same split before and after for random patches.

### B7.2 Transaction

1. `SELECT … FOR UPDATE` on the order.
2. Load the order with `invoice` and its payments with their refunds.
3. Require `status === PAID`, an `invoice`, and no refund in `PENDING` or `PROCESSED` on any of its payments.
4. Run `correctedBilling`.
5. Load `settings` with `getSettings(tx)`. Compare `readSellerSnapshot(invoice.seller).state` with
   `settings.business.state`. A difference → 409.
6. `creditNoteNo = await nextCreditNoteNumber(tx, now, settings.tax.creditNotePrefix)`. This is the shared
   `creditnote:<FY>` counter, so refunds and corrections share one gap-free series.
7. `newInvoiceNo = await nextInvoiceNumber(tx, now, settings.tax.invoicePrefix)`.
8. Create the correction row:
   ```ts
   tx.invoiceCorrection.create({ data: {
     orderId, creditNoteNo,
     originalInvoiceNo: invoice.number, originalIssuedAt: invoice.issuedAt,
     originalBilling: order.billing, originalSeller: invoice.seller,
     newInvoiceNo, billing, seller: sellerSnapshot(settings.business), sac: invoice.sac,
     taxablePaise, cgstPaise, sgstPaise, igstPaise, totalPaise,   // copied from the order
     changedFields, reason, createdById: staff.id, issuedAt: now,
   } })
   ```
9. `tx.invoice.update({ where: { orderId }, data: { number: newInvoiceNo, issuedAt: now, seller: sellerSnapshot(settings.business), pdfKey: null } })`.
10. `tx.order.update({ where: { id }, data: { billing } })`.
11. For account orders, `recordAccountActivity` with "Corrected invoice", target newInvoiceNo, kind `billing`, actor
    "Axiomatic team".
12. Write the audit row.

These stay untouched: amounts, items, licenses, `Payment`, `paidAt`, `email`, `placeOfSupply`.

### B7.3 Linkage

- The credit note links to the original invoice (`originalInvoiceNo`, `originalIssuedAt`) and to the new invoice
  (`newInvoiceNo`) on the same row.
- The current `Invoice.number` equals the latest correction's `newInvoiceNo`.
- A second correction cancels the current invoice. Its `originalInvoiceNo` equals the previous `newInvoiceNo`, so the
  chain can be followed.

### B7.4 After a correction

- A refund still works. Its credit note is against the current invoice. Refund credit notes and correction credit
  notes come from the same counter.
- "Resend invoice" sends `order_confirmation` with the new invoice number. The drawer suggests it after a correction.

## B8. Credit-note downloads

| Route | Permission and access | Response |
|---|---|---|
| `GET /api/admin/orders/[id]/credit-notes/[noteId]` | `orders.view` (registry entry; default sample params → 404) | `inline` PDF, `no-store`. 404 when the note is not this order's. |
| `GET /api/orders/[id]/credit-notes/[noteId]?t=` | Same as `invoice.pdf`: `RATE_LIMITS.invoicePdfIp`, `resolveOrderAccess` (member with `invoices.view`, the placer, or the order link), then `loadCreditNoteModel` | `attachment; filename="CreditNote-AXC-26-27-0004.pdf"`, `no-store`, `nosniff`. 404 when the note is not this order's. |

`noteId` is the `InvoiceCorrection.id`. Credit-note numbers contain "/", so they cannot be the path segment.

## B9. Customer-facing changes

### B9.1 `lib/orders/status.ts` `OrderStatusDto`

New fields:

- `placedByStaff: boolean`
- `canceledByStaff: boolean`
- `termsRequired: boolean`: `createdByStaffId !== null && termsAcceptedAt === null` and the status is unpaid
- `creditNotes: { id, number, issuedAt, cancelsInvoice }[]`
- `invoice.replaces: { invoiceNo: string; creditNoteNo: string } | null` (the cancelled invoice and the credit note that
  cancelled it; built as a pair so the page and the PDF can name both)

`canRetry` becomes `false` when `canceledByStaffAt` is set.

### B9.2 `components/store/order/order-model.ts`

Staff-created and unpaid (AWAITING_PAYMENT):

- Hero: tone `blue`, icon `receipt_long`, title "Ready for payment", body "Our team prepared this order for you. Check
  the items and billing details, then pay securely. We issue your licenses as soon as the payment is confirmed."
- Actions: "Pay now" (retry, primary) and "Contact support" (`/support`). No "Edit order" → /cart.

Staff-cancelled:

- Hero: tone `slate`, icon `cancel`, title "Order cancelled", body "Our team cancelled this order, so it can’t be paid.
  Contact us if you still want to buy."
- Action: "Contact support".

`orderPaths()` gains `creditNotePdf(noteId)`, which carries `?t=` like `invoicePdf`.

### B9.3 `components/store/order/order-view.tsx`

- When `termsRequired`, show the checkout terms checkbox above the hero actions. Reuse the checkout component and copy
  "I agree to the License agreement, Terms and Refund policy." with its links. Until it is ticked, "Pay now" is
  disabled with an error tied to the checkbox. The retry POST sends `acceptTerms: true`.
- Under `InvoiceSummary`, add a "Credit notes" list: `Credit note ${number} · cancels invoice ${cancelsInvoice} · ${date}`
  with a "Download" link.
- The invoice model input passes `document.replaces`.

### B9.4 Other customer-facing changes

- `lib/orders/access.ts` (D19): `isPurchaser` is `false` when `auth?.user.kind === "STAFF"`. Add a test in
  `tests/db/order-access.test.ts`.
- `lib/portal/orders.ts`:
  - `placedByLabel(placedBy, createdByStaff)` returns "by Axiomatic team" for orders created by staff.
  - `ORDER_SELECT` adds `createdByStaffId`.
  - The portal search by invoice number also matches `invoiceCorrections.some.originalInvoiceNo`.

## B10. Reports (Option A bookkeeping)

These changes are in `lib/admin/reports/queries.ts` and `exports.ts`. Every invoice ever issued is counted once, in the
month it was issued. Every credit note is counted in the month it was issued.

- **`invoicesByMonth`, `invoicesByState`:** `UNION ALL` two sources. The first is current invoices (`"Invoice" i JOIN "Order" o`,
  window on `i."issuedAt"`). The second is cancelled originals (`"InvoiceCorrection" c JOIN "Order" o`, window on
  `c."originalIssuedAt"`, amounts from `c.*`, place of supply `o."placeOfSupply"`). Group the union.
- **`invoicedSalesByProduct`:** the same union, joined to the order items. "Invoiced orders" counts
  `DISTINCT document number`.
- **`creditNotesInWindow`:** merge refund credit notes (unchanged) with correction credit notes (`issuedAt` in the
  window):
  - `kind: "correction"`, `status: "PROCESSED"`, `amountPaise = c.totalPaise`
  - split from the `c` amount columns, `byProduct` by line shares
  - `order.invoiceNumber = c.originalInvoiceNo`, `order.billing = c.originalBilling`
  - Sort by `issuedAt` and slice to `take`. `CreditNoteRow` gains `kind: "refund" | "correction"`.
- **`salesRegister`:**
  - Add the cancelled originals as rows: number, date, customer and GSTIN from `originalBilling`.
  - Add a column "Note": "Cancelled by AXC/…" on cancelled rows, and "Replaces AXS/…" on current invoices that have a
    correction.
- **`refundsRegister`:** the "Refund status" column shows "Billing correction" for correction notes.
- **`salesByProduct`:** `invoiceCount` adds the count of corrections whose `originalIssuedAt` is in the window.
- **Result:** in the correction month the net is zero (+ new invoice, − credit note), and the original month is
  unchanged.

## B11. Admin views and UI (Admin > Orders)

### B11.1 Data (`lib/admin/orders/model.ts`, `detail.ts`, `list.ts`, `filters.ts`)

`AdminOrderDetail` gains:

- `createdBy: { id: string; name: string } | null`
- `canceledByStaffAt: string | null`
- `termsAcceptedAt: string | null`
- `items[].planId`
- `payments[]`: `offline: boolean`, `reference`, `receivedAt`, `recordedBy: string | null`
- `corrections: { id, creditNoteNo, originalInvoiceNo, originalIssuedAt, newInvoiceNo, issuedAt, changedFields: string[], by: string }[]`
- `edit: { allowed: boolean; reason: string | null }`
- `paymentLink: { allowed: boolean }`
- `correction: { allowed: boolean; reason: string | null }`
- `refund.unavailableReason: string | null`

`orderSearchWhere`:

- An exact document number also matches `{ invoiceCorrections: { some: { OR: [{ originalInvoiceNo }, { creditNoteNo }] } } }`.
- The contains search adds the same OR on `originalInvoiceNo`.

Paths: `orderCreditNotePath(id, noteId)`, `ORDER_QUOTE_PATH`, `ORDER_OFFLINE_PATH`, `orderPaymentLinkPath(id)`,
`orderCancelPath(id)` and `orderCorrectBillingPath(id)`.

### B11.2 Page and the "New order" drawer

`app/admin/orders/page.tsx` loads `adminOrderPlanOptions(db)` when `canView` and `can(role, "orders.create")`, then
passes them to `OrdersView`. The query lives in `lib/admin/orders/queries.ts` and returns plans that are not archived
and not TRIAL, whose product is not DRAFT: `{ id, productId, productName, planName, type, pricePaise, perUnit, maxQty, productPublished }`.

Header action: `AdminAction perm="orders.create" variant="primary" icon="add"` with the text "New order". It opens
`?new=1`.

`components/admin/orders/new-order.tsx` renders `NewOrderDrawer`. It reuses
`components/admin/orders/order-form.tsx`, which the edit card also uses. The account search hook moves from
`issue-license.tsx` to `components/admin/customers/use-account-search.ts`, and both callers use it.

Drawer content, in order:

1. **Customer.** Search input labelled "Customer", placeholder "Business, name, email or GSTIN". Results show as a radio
   list (`role="radiogroup"`) of business + owner email. When one is chosen, it shows the name with "Change". Choosing
   a customer:
   - fetches `GET /api/admin/customers/:id` (licenses for target lines)
   - prefills the billing fields: name, email and mobile from the owner; business, GSTIN, address, city, state and
     PIN from the account
2. **Items.** One row per line:
   - "Plan" (`NativeSelect` with an optgroup per product, option text `${planName} · ${formatINR(price)}`)
   - "Type" (`ChoiceSelect`: New license, Renewal, Upgrade, Add-on, limited by `ITEM_KIND_PLAN_TYPES`)
   - "For license": shown when the line needs a target. A `NativeSelect` of the account's licenses for the same
     product, showing `id · plan · status`.
   - "Quantity": a number input, shown only for per-unit plans and add-ons (max `maxQty ?? 10`)
   - a remove button with icon `delete` and `aria-label="Remove item ${n}"`
   - "Add item" button below
   - Line issues from the quote show under their row (`role="alert"`, tied with `aria-describedby`)
3. **Coupon** (optional). Its result comes from the quote: label, or the error message on the field.
4. **Billing details**, with the hint "Printed on the tax invoice.": name, email, mobile, business, GSTIN, address,
   city, state, PIN. These use the same messages as checkout (`BILLING_ERRORS`).
5. **Summary** (`aria-live="polite"`). The server quote is debounced 300 ms and refreshed on every change: Subtotal,
   Discount, Taxable value, CGST/SGST or IGST, Total. The note reads "Prices come from the catalog, exactly as at
   checkout." While loading, show "Updating…".
6. **Payment.** A `fieldset` with the legend "How will they pay?" and two radios:
   - "Send a payment link", hint "They pay online. Licenses are issued when the payment is confirmed."
   - "Record a payment we’ve received", hint "Cash, UPI, bank transfer or cheque. Licenses and the tax invoice are
     issued now." Disabled with `requiresLabel("payments.record_offline")` when the role lacks it.
   - Offline fields:
     - "Method" (`ChoiceSelect`)
     - "UTR or reference" or "Cheque number", optional for cash
     - "Received on" (`type="date"`, `max` today in IST)
     - "Amount received (₹)", hint `Must equal the order total, ${total}. Partial payments can’t be recorded.`
7. **"Reason (saved to the audit log)"**, required.
8. **Submit:**
   - Link mode: "Create order".
   - Offline mode: "Record payment". It first opens a `ConfirmDialog` (`requireReason={false}`, tone `primary`,
     icon `payments`) titled `Record ${total} and issue licenses?` with the description
     `This marks the order paid, issues its licenses and tax invoice now, and emails the customer. It can’t be undone in the console.`
     The confirm label is "Record payment".

`requestId` is `crypto.randomUUID()`, created when the drawer opens and kept across retries. That makes a double click
or a network retry idempotent.

After success:

- **Link mode:** the form is replaced by a panel:
  - Heading `Order ${id} created`.
  - Read-only "Payment link" input, plus "Copy link".
  - Text `We’ll email it to ${email}. The link works for 30 days.`
  - Note "Opening this link yourself won’t show the customer’s license key, but only send it to the customer."
  - Buttons "Open order" and "Create another".
- **Offline mode:** `adminToast.success(`${id} paid · Invoice ${no} · ${n} licenses issued`)`, then `router.replace`
  to `?id=`.

### B11.3 Order drawer changes (`components/admin/orders/order-drawer.tsx`)

**Facts:**

- "Created by" shows `${name} (staff)` when set.
- For offline payments, the payments section shows `${method} · ref ${reference} · received ${date} · recorded by ${name}`.

**Edit card** (`edit` slot), title "Edit order":

- The form is the order form without the customer picker and without the payment section.
- It is read-only (with a note) when the role lacks `orders.edit`: "Your role can’t edit orders."
- It is also read-only when `!edit.allowed`. The note is `edit.reason`:
  - "Paid orders keep their items and amounts."
  - "A payment is being confirmed, so the order can’t change now."
  - "This order was cancelled by our team."
- Submit "Save changes". On success, toast "Order updated" and show the "Payment link" panel when an email change gave
  a new URL.

**Footer.** The existing View invoice, Resend invoice, Mark reviewed and Issue refund stay. New:

- "Payment link" (`orders.create`, icon `payments`, when `paymentLink.allowed`). Opens a Dialog that fetches the link
  (`send: false`), shows the read-only input with "Copy link", and has the button "Email it to ${email}" (`send: true`,
  toast "Payment link emailed").
- "Cancel order": `DestructiveAction actionKey="orders.cancel" targetId={order.id}`. Consequence: "The customer can’t
  pay this order any more, and open payment pages stop working. Nothing was charged." Success "Order cancelled".
- "Correct billing" (`invoices.correct`, icon `edit_document`, when `correction.allowed`; otherwise hidden for unpaid
  orders, or disabled with `correction.reason` for paid ones). It opens a `Dialog` titled `Correct billing details for ${id}`:
  - The fields name, business, GSTIN, address, city, PIN and mobile are editable.
  - State and email are shown read-only, with the hint "The state sets the GST split, so it can’t change."
  - A "Reason" field.
  - The consequence text: "We’ll issue a credit note that cancels invoice ${number} in full and a new invoice with these
    details. Amounts, licenses and the payment don’t change."
  - Confirm "Issue corrected invoice". Success toast `Credit note ${cn} and invoice ${inv} issued`, followed by a
    "Resend invoice" suggestion.
- "Issue refund" gets `disabledReason={refund.unavailableReason}` for offline payments.

**Section "Invoice corrections"** (only when there are any). Each row:
`${creditNoteNo} cancels ${originalInvoiceNo} (${date}) → ${newInvoiceNo}` with a link "Credit note PDF"
(`AdminAction href newTab`).

**Other:**

- `components/admin/model.ts` `STATUS_META` needs no change.
- Show a "Cancelled by staff" badge note next to the status when `canceledByStaffAt` is set.

## B12. Tests (PART B)

Unit:

- `tests/unit/admin-orders-records-model.test.ts` (new):
  - Every body schema: requestId uuid, items bounds, offline method/reference/date rules, amount integer.
  - `correctedBilling`:
    - state and email locked
    - a GSTIN from another state refused
    - adding a same-state GSTIN allowed
    - a no-op detected
    - `changedFields` names
  - **The tax split stays the same** for a correction: `quote()` with the stored state gives equal CGST/SGST/IGST.
  - Offline received-date window in IST, at the boundaries.
- `tests/unit/invoice-model.test.ts` (extend):
  - Credit-note model: title, labels, reference "AGAINST INVOICE", "Total credited", totals equal to the invoice
    totals, the same per-line CGST/SGST shares, amount in words.
  - The "replaces" note on the invoice.
  - `documentFileName`.
- `tests/unit/admin-reports-model.test.ts`: monthly rows with a correction. The original month is unchanged and the
  correction month nets to zero.
- `tests/unit/order-model.test.ts` (store): hero and actions for the staff-created unpaid state and the staff-cancelled
  state; `termsRequired`.
- `tests/unit/admin-orders-model.test.ts`: provider and method labels including offline.

DB tests. Use `tests/db/admin-orders-fixtures.ts` and `checkout-fixtures.ts`, and add `makeAdminOrderInput(accountId, plans)`.

1. **`admin-orders-create.test.ts`:**
   1. Quote parity: the admin quote equals the `POST /api/checkout/quote` result for the same items, coupon and state,
      both intra-state and inter-state.
   2. Payment link:
      - 201, `AWAITING_PAYMENT`, zero payments, no invoice, no license.
      - `createdByStaffId` and `staffRequestId` set; `placedByUserId` null; `termsAcceptedAt` null.
      - An outbox `order_payment_link` row.
      - An audit row with the reason.
      - The URL validates with `inspectOrderToken`.
   3. Licensed only by the webhook:
      - Retry without `acceptTerms` → 422.
      - With it → 201, a fresh `CREATED` payment at the total, and terms recorded.
      - `mockCapture` + `processPaymentEvent` → PAID, an invoice, licenses issued **once**.
      - Re-delivery → duplicate.
      - No license exists before the capture.
   4. Offline:
      - 201 PAID, `Payment { provider "offline", status CAPTURED, providerOrderId "offline:<id>", reference, receivedAt, recordedById }`.
      - The invoice number comes from the AXS FY counter.
      - Licenses have `keyCiphertext` (v1.), `keyHash` and `keyLast4`, and no plaintext anywhere.
      - `OrderItem.fulfilledAt` and the terms snapshots are set for renewal lines.
      - Outbox `order_confirmation` and `license_issued`.
      - A `CouponRedemption` row.
      - Exactly one staff audit row "Recorded offline payment" and no "Webhook processed" row.
   5. Offline double submit:
      - Sequential, same `requestId` → 200 `replayed`, still one order, one invoice, the same licenses, counters
        advanced once.
      - Concurrent `Promise.all` of two → one order and one replay.
      - Another staff member with the same `requestId` → 409.
   6. Offline refusals:
      - Amount ≠ total → 422 and nothing stored.
      - Received date in the future or older than 180 days → 422.
      - A reference missing for UPI → 422.
      - A target license revoked between quote and submit → 409 `fulfilment_failed` and nothing stored (no order, no
        invoice number used).
   7. Roles for every new route, for each of signed out, customer, Owner, Administrator, Support and Finance. The
      registry matrix covers this. Add EXPLICIT_CASES "Support cannot create orders", "Administrator cannot record
      offline payments" and "Finance can correct billing".
2. **`admin-orders-edit.test.ts`:**
   1. Edit items or the coupon:
      - Totals recomputed equal a fresh quote.
      - Items replaced.
      - `CREATED` payments become `CANCELED` with `supersededAt`.
      - The next retry creates a new provider order at the **new** amount.
   2. Mock capture of the superseded attempt → REVIEW with `SUPERSEDED_ATTEMPT_REASON` and no licenses.
   3. `retryPayment` does not reopen a `CREATED` attempt whose amount differs from the total. This is set up
      directly in the DB.
   4. Refused for PAID, CONFIRMING (with an AUTHORIZED attempt), REVIEW and staff-cancelled orders.
   5. A limited coupon whose last slot this order holds can be kept on edit (`excludeOrderId`).
   6. A billing email change makes the old link invalid and the new one valid.
   7. No-op → `changed: false` and no audit row.
   8. Cancel:
      - `canceledByStaffAt` set and `CREATED` → `CANCELED`.
      - Customer retry → 409 `not_retryable`; status DTO `canRetry` false.
      - A second cancel → `changed: false` with no new audit row.
      - Reason first: 422 even for a paid order.
3. **`admin-billing-correction.test.ts`:**
   1. A paid order (via webhook) is corrected:
      - Credit note `AXC/<FY>/n` and new invoice `AXS/<FY>/m` come from their counters, with no gap. A refund issued
        afterwards takes the next AXC number.
      - The `InvoiceCorrection` row holds the original number, date, billing and seller, and the amounts equal the
        order's.
      - `Invoice.number` equals `newInvoiceNo`.
      - `Order.billing` is corrected.
      - Order amounts, items, `paidAt`, `email` and `placeOfSupply` are unchanged.
      - License rows (status, terms, key fields) and `Payment` rows are deep-equal before and after.
      - One audit row.
   2. A state change, an email change, a GSTIN from another state → 422. A no-op → 422 `nothing_changed`. A seller
      state change in settings → 409.
   3. PARTIALLY_REFUNDED, REFUNDED, a PAID order with a PENDING refund, REVIEW and unpaid orders → 409
      `not_correctable`.
   4. A second correction chains: `originalInvoiceNo` equals the previous `newInvoiceNo`.
   5. Credit-note PDF:
      - The admin route renders `%PDF-`.
      - The customer route works with the order link token.
      - Another account's member gets 404, as does a note id from another order.
      - The invoice PDF of the order shows the new number and the "replaces" note (`loadInvoiceModel`).
   6. Reports: `invoicesByMonth` counts the original in its month and the new invoice in the correction month.
      `creditNotesInWindow` includes the correction note (`kind: "correction"`). The `gstByMonth` net for the
      correction month is zero. The sales register shows the cancelled row.
4. **Existing tests to keep green:** `webhook-payment`, `checkout-payment-flow`, `admin-refund-flow`,
   `admin-refund-failures`, `reconcile-orders`, `invoice-pdf`, `fulfil`, `counters` and `checkout-orders`. That
   proves the extraction changed nothing.
5. **`order-access.test.ts`:** a staff session with a valid token → `isPurchaser` false.

---

## 4. scripts/check-admin.mjs (after both parts)

- `reasonsJourney` cases. Each must answer 422 `reason_required` with no reason and 422 for "no". Each body is
  otherwise valid, so the reason check is what fails:
  - `["customers.verify_email", "POST", /api/admin/customers/${fx.customer.accountId}/verify-email, {}]`
  - `["customers.set_password_link", "POST", …/set-password-link, {}]`
  - `["orders.cancel", "POST", /api/admin/orders/${fx.paidOrder}/cancel, {}]`
  - Outside DESTRUCTIVE_ACTIONS:
    - `["customer create", "POST", "/api/admin/customers", { name: "Reason Check", email: `reason-${run}@example.com` }]`
    - `["customer edit", "PATCH", /api/admin/customers/${acct}, { name: "Changed" }]`
    - `["order create (link)", "POST", "/api/admin/orders", fx.orderInput]`
    - `["order create (offline)", "POST", "/api/admin/orders/offline", { ...fx.orderInput, method: "cash", receivedOn: today, amountPaise: 1 }]`
    - `["order edit", "PATCH", /api/admin/orders/${fx.paidOrder}, { couponCode: null }]`
    - `["billing correction", "POST", /api/admin/orders/${fx.paidOrder}/correct-billing, { billing: {...} }]`
- `reasonTargets` adds:
  - the customer user `{ email, emailVerifiedAt, securityEpoch }`
  - the paid order `{ status, totalPaise, billing }` with its invoice number
  - the count of `Order` rows created in the run
- `pageRoutes` adds `/admin/customers?new=1` and `/admin/orders?new=1`, for the roles that can open them.
- A Finance journey covers both modes:
  - Create a payment-link order, open its link, and check "Ready for payment".
  - Record an offline order, then correct its billing. Check the toast numbers, the drawer section and that the
    credit-note PDF answers 200.
  - Record created rows with `remember()`.
- A Support journey: create a customer, copy the link (the clipboard API is stubbed), mark the email verified and edit
  the mobile number.
- `cleanUp` deletes `InvoiceCorrection` **before** `Invoice` and `Order`. It also deletes users and accounts created
  by the run, by id: AccountMember, AuthToken, AccountActivity, then BusinessAccount and User.
- Update the header doc (lines 1-47).

## 5. Docs (do not edit `docs/server-runbook.md`)

- **`docs/decisions.md`:**
  - A section "## Admin records: customers and orders (owner decisions, 2026-10-08)", with one dated bullet group per
    D1-D20.
  - Amend business rule 7 (permissions, line ~63).
  - Amend the "Licenses only in the webhook" note (~93) with the offline-payment exception.
  - Amend the invoice and credit-note numbering note (~50): the shared AXC series for refunds and corrections.
  - Amend the placeholder notes (~844-860): `createdByStaffId`.
  - Amend the epoch list (~1089).
- **`docs/security.md`:**
  - Threat model "Payment tampering" row (32): licenses come only from the signed webhook, an audited manual staff
    issue, or an **Owner/Finance offline payment record**. The record needs a reason, the amount must equal the server
    total, it is idempotent, it runs one transaction through the same fulfilment code, and it is audited.
  - New subsection "Staff powers over customer accounts", covering:
    - marking emails verified (which claims guest orders)
    - email changes (epoch, sessions, tokens, notice to the old address)
    - set-password links (shown once, 7 days, single use, never logged or audited, voided by an email change or a new
      link, refused once a password exists)
    - staff never receive the one-time key delivery
    - the placeholder-takeover guard
  - A "who can do what" table for the 7 new permissions.
  - The sessions section (128-157): add "admin email change" to the epoch events.
- **`docs/api.md`:**
  - Admin permissions table.
  - Orders section (219-227): quote, create, offline, PATCH, cancel, payment-link, correct-billing, credit-note PDF.
  - Customers section (229-240): POST, PATCH, verify-email, set-password-link.
  - Checkout and orders: the retry body `acceptTerms`, `/api/orders/:id/credit-notes/:noteId`.
  - Auth: the reset GET returns `mode`.
- **`docs/architecture.md`** (33, 141): the webhook-only statement gets the offline exception.
- **`docs/go-live-checklist.md`:**
  - Under "Before live sales > Payments", add "Decide who records offline payments. Finance checks the UTR against the
    bank statement before recording."
  - Under "Application", add "Try a set-password link and a payment-link order end to end once SMTP works."
- **`README.md`:** the module descriptions for Orders and Customers.

## 6. Out of scope and follow-ups

- Refunds of offline-paid orders (D20). This needs a "record offline refund" path: a Refund row PROCESSED with no
  provider call, a credit note, and license reversal.
- Re-downloading the cancelled original invoice from the archive (an admin-only PDF route from
  `InvoiceCorrection.original*`).
- Notifying the customer by email about a corrected invoice. Today staff use "Resend invoice".
- Changing the account of an unpaid order.

## 7. Build order

1. **S0:** migration; rbac with its labels, copy and tests; rate limits; templates and seeds; validation exports;
   `PricingBuyer`; `orderCreateData` and `assertPricedCart`; `fulfilPaidOrder` extraction plus the superseded-attempt
   check; the document model and PDF labels. Run `pnpm typecheck && pnpm test:unit && pnpm test:db`. Everything
   existing must pass before step 2.
2. **PART A:** A2.4 placeholder fix, then A2/A2.2/A2.3 (create and set-password), A4, A1, A3, the UI, then the tests.
3. **PART B:** B1, B2 + B2.1 (retry, terms, staff cancel), B3, B4, B5, B6, B7 + B8, B9, B10, B11 UI, then the tests.
4. check-admin, docs, `pnpm lint`, and a production build check (`.next-adminrec`, removed afterwards).

Files both parts touch, edited only in S0 or by the named part:

| File | Owner |
|---|---|
| `lib/rbac.ts`, `PERMISSION_LABELS`, `DESTRUCTIVE_*`, rate limits, `defaults.ts`, seeds | S0 |
| `lib/admin/routes/customers-licenses.ts` | A |
| `lib/admin/routes/orders.ts` | B |
| `lib/admin/customers/model.ts` and `queries.ts` (licenses `productId` / `planType`) | A (B reads them) |
| `lib/admin/audit/model.ts` | A |
| `docs/*` | the last step, both parts |

Registry entries to add:

```ts
// customers-licenses.ts
{ method: "POST", path: "/api/admin/customers", perm: "customers.create" },                         // {} -> 422
{ method: "PATCH", path: "/api/admin/customers/[id]", perm: "customers.edit" },                     // {} -> 422
{ method: "POST", path: "/api/admin/customers/[id]/verify-email", perm: "customers.verify_email" }, // {} -> 422 reason
{ method: "POST", path: "/api/admin/customers/[id]/set-password-link", perm: "customers.manage" },  // {} -> 422 reason
// orders.ts
{ method: "POST", path: "/api/admin/orders", perm: "orders.create" },                               // {} -> 422
{ method: "POST", path: "/api/admin/orders/quote", perm: "orders.create" },                         // {} -> 422
{ method: "POST", path: "/api/admin/orders/offline", perm: "payments.record_offline" },             // {} -> 422
{ method: "PATCH", path: "/api/admin/orders/[id]", perm: "orders.edit" },                           // {} -> 422
{ method: "POST", path: "/api/admin/orders/[id]/cancel", perm: "orders.edit" },                     // {} -> 422 reason
{ method: "POST", path: "/api/admin/orders/[id]/payment-link", perm: "orders.create", sampleBody: { send: false } }, // 404
{ method: "POST", path: "/api/admin/orders/[id]/correct-billing", perm: "invoices.correct" },       // {} -> 422
{ method: "GET", path: "/api/admin/orders/[id]/credit-notes/[noteId]", perm: "orders.view" },       // 404
```

## 8. PART A build notes and deviations (2026-10-08)

PART A was built on its own, before S0 and PART B. It took only the S0 pieces it needs; PART B adds the rest.

- **Migration split (D1).** PART A's additive migration is `20261008090359_admin_records_customers` (only
  `User.createdByStaffId`). PART B adds the `Order` and `Payment` columns and `InvoiceCorrection` in its own additive
  migration. Reason: each part's schema change ships with the code that uses it; nothing unused sits in the database.
- **S0 split.** PART A added: the three customer permissions, the `customers.verify_email` and
  `customers.set_password_link` destructive keys (labels, audit labels, dialog copy), the customers module description,
  the `adminCustomerCreate`, `adminCustomerWrite` and `adminSetPasswordLink` rate limits, the `set_password` and
  `account_email_changed` templates (defaults, seed rows with the same copy, trigger labels) and the validation exports
  of 3.1. Counts are therefore Owner 25, Administrator 21, Support 11, Finance 8 (25 permissions) until PART B adds
  `orders.create`, `orders.edit`, `payments.record_offline`, `invoices.correct` (29/21/11/12), `orders.cancel`, its
  rate limits, `order_payment_link` and the orders module description. `PricingBuyer`, `orderCreateData`,
  `fulfilPaidOrder` and the document model (3.2-3.5) are untouched.
- **Check order on create and edit.** The route parses the body first (422 `validation_failed` for bad fields), then
  counts the rate limit, then the service checks the reason (422 `reason_required`) before any lookup or write. The
  destructive routes (verify-email, set-password-link) check the reason before any lookup, as designed.
- **`useSetPasswordLink` message (A4.2).** Shown for any ACTIVE customer member without a password, not only
  staff-created ones: that is exactly when the drawer offers "Create set-password link" (`canSetPassword`) and when the
  set-password-link route accepts the person. Invited placeholders keep `noPassword`.
- **Edit without an owner (A3).** Person fields answer 409 `no_owner` with "This account has no active owner, so
  there’s no person to change." (the shared `noOwner` copy says "Choose a member instead", which does not apply to an
  edit). The edit card shows a note and only the business fields in that case.
- **Set-password link race.** Inside the transaction the service re-reads the person: a password set or an email
  changed since the checks answers 409 `has_password` / `customer_changed` instead of issuing a stale link.
- **Small additions.** `BILLING_DETAIL_KEYS` is exported from `lib/portal/billing.ts` (was the private `DETAIL_KEYS`);
  `customerDestructiveBody` is the shared `{ reason, userId? }` body of both destructive routes; `/forgot` uses
  `needsFirstPassword()`; audit "Changed:" lists use the API field names (`legalName`, `gstin`, ...); the 409
  `email_taken` body also carries `fieldErrors.email` so the form shows it on the field.
- **UI.** "Email already verified" and "New email already verified" show "Requires Owner / Administrator / Support" as
  hint text (not a tooltip) when the role lacks `customers.verify_email`, so it also reads on touch screens. The
  set-password dialog takes focus on the one-time link panel and has a "Close" button.
- **Not built in PART A.** D10-D20, B1-B12 and the order parts of sections 4 and 5.

## 9. PART B build notes and deviations (2026-10-08)

PART B was built on top of PART A in the same branch. It took the remaining S0 pieces (the order permissions, the
`orders.cancel` key, the order rate limits, the `order_payment_link` template, the orders module description,
`PricingBuyer`, `orderCreateData` / `assertPricedCart`, `fulfilPaidOrder()` and the document model).

- **Migration (D1).** `20261008150000_admin_records_orders` holds the `Order` and `Payment` columns and the
  `InvoiceCorrection` table (only `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`, `ADD CONSTRAINT`). `prisma migrate dev`
  refuses to run non-interactively when it warns about a new unique index, so the SQL came from `prisma migrate diff`
  (config datasource -> schema) and was applied with `prisma migrate deploy`; the result is the same additive script.
- **Terms on retry (D11).** `retryPayment(db, access, { terms })` takes `{ acceptTerms, version }` from the retry route
  (which passes `CHECKOUT_TERMS_VERSION`): importing create-order.ts from payment-attempt.ts would be an import cycle.
  Inside its transaction `retryPayment` also re-checks the order total and the staff cancel, so a staff edit or cancel
  racing a "Pay now" never opens an attempt at a stale amount.
- **"Pay now" before the terms are ticked.** The button stays enabled; pressing it shows the checkout error under the
  checkbox (tied with `aria-describedby`) and moves focus there, instead of a disabled button that gives no reason.
- **Locked edit card.** For a role without `orders.edit`, and for orders that cannot change (paid, settling, cancelled
  by staff), the "Edit order" card shows a short note instead of the disabled form, so Administrator and Support never
  fire quote requests their role would refuse.
- **Replays across modes (D13).** A `requestId` that created a payment-link order and is then sent as an offline
  payment (or the reverse) answers 409 `duplicate_request`, like another staff member's repeat.
- **Guest orders.** Unpaid orders without an account (checkout guests) can be edited too; they are priced as a guest
  (NEW items only), exactly as `accountPricingBuyer(null)` describes.
- **Order page copy.** Besides "Ready for payment" and "Order cancelled", a staff-created order the customer closed at
  the provider reads "Payment canceled … You can pay whenever you’re ready." (no cart), and FAILED shows "Try again"
  with "Contact support" (no "Back to checkout"). The page lists "Credit notes" under the invoice with a Download link.
- **Lines whose plan is no longer sold** (an unpaid order's archived plan) stay in the edit form, labelled
  "(no longer sold)", and are sent as they stand so the server decides.
- **Audit wording.** "Updated order" names the billing fields that changed (`billing (city, gstin)`); "Cancelled order"
  adds the amount and the attempts closed.
- **Customer credit-note route** checks the order access first (401/403/404 as the invoice PDF), then the note id shape.
- **Tests.** Quote parity compares the admin quote with checkout's own code path (`priceCart` + `toQuoteDto` for a
  guest), because the public checkout route needs an anonymous CSRF token the DB test harness does not issue. "A target
  license revoked between the quote and the submit" is simulated with a hook that runs right after `priceCart`.
- **Not built (follow-ups, section 6):** refunds of offline payments (D20), a PDF of the cancelled original invoice, an
  email to the customer about a corrected invoice, changing the account of an unpaid order.

## 10. Review fixes (2026-10-08)

A security, money and UI review after both parts; decisions.md "Admin records review fixes" R1-R9 has the reasons.

- **Team invitations (A3).** An email change also voids TEAM_INVITE tokens, and `resolveInvite` refuses a link whose
  `AuthToken.email` is no longer the invitee's email (410 `invite_revoked`).
- **Pay-only payment links (B2, B4, B5; amends D19).** `lib/orders/token.ts` signs a second token kind, "p1"
  (`signOrderPayToken`, HMAC over `order-pay:p1:<orderId>:<emailTag>:<exp>`); `inspectOrderToken` returns its
  `scope`. `OrderAccess` gains `tokenScope`; a pay-only token gives `viaToken` and `canAct` but never `isPurchaser`.
  `orderPayUrl()` (lib/payments/fulfilment.ts) builds the links of payment-link orders, re-shares, unpaid edits and the
  `order_payment_link` email; `retryPayment` answers a pay-only start with a pay-only `orderToken`. The
  order_confirmation and license_issued emails keep full links. A replay whose order is no longer payable answers 409
  `not_payable`.
- **Staff never act (D11).** `OrderAccess.canAct` is false for a staff session and `assertCanActOnOrder` answers 403
  `staff_checkout` (retry, cancel, return, the dev mock checkout).
- **Guest claims in the audit (A1-A3).** `guestClaimNote(orderIds)` (lib/admin/customers/model.ts) appends
  " · N guest order(s) moved to this account: AX-…" (at most 20 ids, then "and N more") to the create, edit and
  mark-verified audit rows; PATCH returns `claimedOrders`. No refusal when guest orders exist (owner decision; see R4).
- **Late failures (D14, D15).** The webhook's `onFailed` returns `stale_attempt` for a superseded attempt or a
  staff-cancelled order after recording the attempt as FAILED.
- **Locks and replays (D13).** `fulfilPaidOrder` locks the coupon row first; offline payments answer a deadlock or lock
  timeout with 503 `try_again`. Both create services wrap their work and, on any error, answer the order the same
  `requestId` created (`concurrentReplay`) before rethrowing.
- **Seller GSTIN (D17).** The correction also compares the normalised GSTIN of the original invoice's seller snapshot
  with Settings (409 `seller_state_changed`, message "state or GSTIN").
- **UI (B11).** The customer picker follows "Issue license" (list kept, controlled radios, "Selected: …" hint; the
  "Change" button is gone); the edit card keeps the new payment link above the keyed form; "Cancel order" dismisses with
  "Keep order" (`ActionCopy.dismiss`); the "Payment link" dialog focuses itself while loading and the refusal when it
  fails; offline refusals without a field are thrown into the confirmation dialog; `useOrderQuote` returns `error` and
  clears the quote on failure, and `OrderSummary` takes `emptyText` / `error`; the quote issue id moved to the Plan
  select's `aria-describedby`; `InvoiceSummary` lists `model.extraNotes` (kept in print); re-share and
  `order_payment_link` copy is neutral ("Order {{order_id}} is ready to pay.").
