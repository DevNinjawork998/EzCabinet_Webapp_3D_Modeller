-- CreateEnum
CREATE TYPE "ProductionStage" AS ENUM ('MEASURE', 'CUTTING', 'EDGING', 'ASSEMBLY', 'QC', 'READY');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('ORDER_PLACED', 'PAYMENT_CONFIRMED', 'STAGE', 'DELIVERY_BOOKED', 'PICKED_UP', 'DELIVERED', 'DELIVERY_FAILED');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "productionStage" "ProductionStage",
ADD COLUMN     "whatsappOptIn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "whatsappOptInAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "deliveryId" TEXT,
    "kind" "NotificationKind" NOT NULL,
    "stage" "ProductionStage",
    "dedupeKey" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "vars" JSONB NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "metaMessageId" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappAutoReply" (
    "phone" TEXT NOT NULL,
    "repliedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappAutoReply_pkey" PRIMARY KEY ("phone")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_dedupeKey_key" ON "Notification"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_metaMessageId_key" ON "Notification"("metaMessageId");

-- CreateIndex
CREATE INDEX "Notification_status_queuedAt_idx" ON "Notification"("status", "queuedAt");

-- CreateIndex
CREATE INDEX "Notification_orderId_idx" ON "Notification"("orderId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
