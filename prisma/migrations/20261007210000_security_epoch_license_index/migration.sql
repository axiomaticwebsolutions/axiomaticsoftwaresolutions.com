-- AlterTable
ALTER TABLE "User" ADD COLUMN     "securityEpoch" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "License_productId_accountId_idx" ON "License"("productId", "accountId");

