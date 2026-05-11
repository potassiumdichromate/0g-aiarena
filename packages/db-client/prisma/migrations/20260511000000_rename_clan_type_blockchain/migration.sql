-- Rename ClanType enum values from fantasy factions to blockchain ecosystems
-- Old: CYBER | BIO | ARCANE | MECH | SHADOW
-- New: ZEROG | BASE | SOLANA | ETHEREUM | COSMOS

-- Step 1: Add new enum values
ALTER TYPE "ClanType" ADD VALUE IF NOT EXISTS 'ZEROG';
ALTER TYPE "ClanType" ADD VALUE IF NOT EXISTS 'BASE';
ALTER TYPE "ClanType" ADD VALUE IF NOT EXISTS 'SOLANA';
ALTER TYPE "ClanType" ADD VALUE IF NOT EXISTS 'ETHEREUM';
ALTER TYPE "ClanType" ADD VALUE IF NOT EXISTS 'COSMOS';

-- Step 2: Migrate existing data — map old clans to nearest blockchain equivalent
UPDATE "Agent" SET "clan" = 'ZEROG'::\"ClanType\"    WHERE "clan" = 'CYBER'::\"ClanType\";
UPDATE "Agent" SET "clan" = 'COSMOS'::\"ClanType\"   WHERE "clan" = 'BIO'::\"ClanType\";
UPDATE "Agent" SET "clan" = 'SOLANA'::\"ClanType\"   WHERE "clan" = 'ARCANE'::\"ClanType\";
UPDATE "Agent" SET "clan" = 'ETHEREUM'::\"ClanType\" WHERE "clan" = 'MECH'::\"ClanType\";
UPDATE "Agent" SET "clan" = 'BASE'::\"ClanType\"     WHERE "clan" = 'SHADOW'::\"ClanType\";

-- Step 3: Recreate enum with only the new values
-- PostgreSQL requires recreating the type; we use a temp column approach
ALTER TABLE "Agent" ADD COLUMN "clan_new" TEXT;
UPDATE "Agent" SET "clan_new" = "clan"::TEXT;
ALTER TABLE "Agent" DROP COLUMN "clan";

DROP TYPE "ClanType";
CREATE TYPE "ClanType" AS ENUM ('ZEROG', 'BASE', 'SOLANA', 'ETHEREUM', 'COSMOS');

ALTER TABLE "Agent" ADD COLUMN "clan" "ClanType" NOT NULL DEFAULT 'ZEROG';
UPDATE "Agent" SET "clan" = "clan_new"::"ClanType";
ALTER TABLE "Agent" DROP COLUMN "clan_new";

-- Restore index on clan
CREATE INDEX IF NOT EXISTS "Agent_clan_idx" ON "Agent"("clan");
