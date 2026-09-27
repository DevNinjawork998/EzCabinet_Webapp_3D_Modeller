-- Every order belongs to an account (docs/superpowers/specs/2026-09-27-customer-orders-design.md).
-- Ownerless rows are pre-cutover orders (placed before accounts existed —
-- docs/ops/rbac-cutover.md) or local AUTH_ENABLED=false checkouts. One that
-- was paid, or has a delivery, is a real customer's money: the migration
-- refuses rather than delete it, and an admin assigns it an owner by hand.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Order" o
    WHERE o."userId" IS NULL
      AND (o."status" = 'PAID' OR EXISTS (SELECT 1 FROM "Delivery" d WHERE d."orderId" = o."id"))
  ) THEN
    RAISE EXCEPTION 'Ownerless orders that are PAID or have a delivery exist. Assign each an owner ("userId") before applying this migration.';
  END IF;
END $$;

-- The rest are unpaid with no delivery. Notification rows cascade.
DELETE FROM "Order" WHERE "userId" IS NULL;

-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "userId" SET NOT NULL;

-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_userId_fkey";

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
