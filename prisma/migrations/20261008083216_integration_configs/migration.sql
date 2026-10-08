-- CreateEnum
CREATE TYPE "IntegrationKind" AS ENUM ('PAYMENTS', 'EMAIL', 'STORAGE');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "providerKeyId" TEXT;

-- CreateTable
CREATE TABLE "IntegrationConfig" (
    "kind" "IntegrationKind" NOT NULL,
    "settings" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "IntegrationConfig_pkey" PRIMARY KEY ("kind")
);

-- CreateTable
CREATE TABLE "IntegrationSecret" (
    "kind" "IntegrationKind" NOT NULL,
    "field" TEXT NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "last4" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "IntegrationSecret_pkey" PRIMARY KEY ("kind","field")
);

-- AddForeignKey
ALTER TABLE "IntegrationConfig" ADD CONSTRAINT "IntegrationConfig_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSecret" ADD CONSTRAINT "IntegrationSecret_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSecret" ADD CONSTRAINT "IntegrationSecret_kind_fkey" FOREIGN KEY ("kind") REFERENCES "IntegrationConfig"("kind") ON DELETE CASCADE ON UPDATE CASCADE;
