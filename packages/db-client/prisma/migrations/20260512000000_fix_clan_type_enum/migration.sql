-- Fix ClanType enum: replace legacy values (CYBER/BIO/ARCANE/MECH/SHADOW) with ZEROG/BASE/SOLANA

-- Step 1: migrate column to text so we can drop & recreate the enum
ALTER TABLE "Agent" ALTER COLUMN clan TYPE text;

-- Step 2: drop old enum
DROP TYPE IF EXISTS "ClanType";

-- Step 3: create correct enum
CREATE TYPE "ClanType" AS ENUM ('ZEROG', 'BASE', 'SOLANA');

-- Step 4: remap any legacy values to ZEROG, then cast back
UPDATE "Agent" SET clan = 'ZEROG' WHERE clan NOT IN ('ZEROG', 'BASE', 'SOLANA');
ALTER TABLE "Agent" ALTER COLUMN clan TYPE "ClanType" USING clan::"ClanType";
