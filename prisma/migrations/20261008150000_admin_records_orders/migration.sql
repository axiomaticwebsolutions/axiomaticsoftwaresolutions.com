
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "canceledByStaffAt" TIMESTAMP(3),
ADD COLUMN     "createdByStaffId" TEXT,
ADD COLUMN     "staffRequestId" TEXT;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "receivedAt" TIMESTAMP(3),
ADD COLUMN     "recordedById" TEXT,
ADD COLUMN     "reference" TEXT,
ADD COLUMN     "supersededAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "InvoiceCorrection" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "creditNoteNo" TEXT NOT NULL,
    "originalInvoiceNo" TEXT NOT NULL,
    "originalIssuedAt" TIMESTAMP(3) NOT NULL,
    "originalBilling" JSONB NOT NULL,
    "originalSeller" JSONB NOT NULL,
    "newInvoiceNo" TEXT NOT NULL,
    "billing" JSONB NOT NULL,
    "seller" JSONB NOT NULL,
    "sac" TEXT NOT NULL,
    "taxablePaise" INTEGER NOT NULL,
    "cgstPaise" INTEGER NOT NULL,
    "sgstPaise" INTEGER NOT NULL,
    "igstPaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "changedFields" TEXT[],
    "reason" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceCorrection_creditNoteNo_key" ON "InvoiceCorrection"("creditNoteNo");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceCorrection_originalInvoiceNo_key" ON "InvoiceCorrection"("originalInvoiceNo");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceCorrection_newInvoiceNo_key" ON "InvoiceCorrection"("newInvoiceNo");

-- CreateIndex
CREATE INDEX "InvoiceCorrection_orderId_issuedAt_idx" ON "InvoiceCorrection"("orderId", "issuedAt");

-- CreateIndex
CREATE INDEX "InvoiceCorrection_issuedAt_idx" ON "InvoiceCorrection"("issuedAt");

-- CreateIndex
CREATE INDEX "InvoiceCorrection_originalIssuedAt_idx" ON "InvoiceCorrection"("originalIssuedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_staffRequestId_key" ON "Order"("staffRequestId");

-- AddForeignKey
ALTER TABLE "InvoiceCorrection" ADD CONSTRAINT "InvoiceCorrection_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

