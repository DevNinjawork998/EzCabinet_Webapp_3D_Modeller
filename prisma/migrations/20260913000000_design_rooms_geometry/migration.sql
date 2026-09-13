-- One design can be offered in several rooms. Added, backfilled from the old
-- single `room`, then the old column dropped — Prisma's generated diff would
-- have dropped `room` first and lost every existing design's room.
ALTER TABLE "CabinetDesign" ADD COLUMN "rooms" "CabinetRoom"[] NOT NULL DEFAULT ARRAY[]::"CabinetRoom"[];
UPDATE "CabinetDesign" SET "rooms" = ARRAY["room"];
ALTER TABLE "CabinetDesign" ALTER COLUMN "rooms" DROP DEFAULT;
ALTER TABLE "CabinetDesign" DROP COLUMN "room";

-- What the file holds, written at conversion. The catalogue is rebuilt from
-- design rows on publish and cannot read an OBJ there.
ALTER TABLE "CabinetDesign" ADD COLUMN "geometry" JSONB;

-- A family id is now the design id, so the soft reference has nothing to point
-- at. Dropping the column drops its index with it.
ALTER TABLE "CabinetDesign" DROP COLUMN "familyId";
