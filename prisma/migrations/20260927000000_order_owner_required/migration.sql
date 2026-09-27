-- Every order belongs to an account (docs/superpowers/specs/2026-09-27-customer-orders-design.md).
-- Ownerless rows are local/test data from AUTH_ENABLED=false checkouts.
-- Notification rows cascade; Delivery.orderId is set null (existing FK), so a
-- booked delivery keeps its row.
DELETE FROM "Order" WHERE "userId" IS NULL;

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "userId" SET NOT NULL;

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_userId_fkey";

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
