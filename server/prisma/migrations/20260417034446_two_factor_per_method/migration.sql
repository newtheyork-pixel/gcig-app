-- AlterTable
ALTER TABLE "User" ADD COLUMN     "twoFactorEmailEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoFactorTotpEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Backfill per-method flags from the legacy twoFactorMethod column so existing
-- users with 2FA already on keep working.
UPDATE "User"
  SET "twoFactorTotpEnabled" = true
  WHERE "twoFactorEnabled" = true AND "twoFactorMethod" = 'totp';

UPDATE "User"
  SET "twoFactorEmailEnabled" = true
  WHERE "twoFactorEnabled" = true AND "twoFactorMethod" = 'email';
