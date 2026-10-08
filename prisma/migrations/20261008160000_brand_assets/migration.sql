-- CreateEnum
CREATE TYPE "BrandAssetSlot" AS ENUM ('LOGO_LIGHT', 'LOGO_DARK', 'FAVICON');

-- CreateTable
CREATE TABLE "BrandAsset" (
    "slot" "BrandAssetSlot" NOT NULL,
    "mime" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "pngBytes" BYTEA,
    "pngWidth" INTEGER,
    "pngHeight" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "BrandAsset_pkey" PRIMARY KEY ("slot")
);

-- AddForeignKey
ALTER TABLE "BrandAsset" ADD CONSTRAINT "BrandAsset_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
