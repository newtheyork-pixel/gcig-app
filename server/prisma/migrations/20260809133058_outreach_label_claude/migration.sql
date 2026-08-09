-- Claude grades every draft on the same prompt at a higher tier, as a
-- second independent opinion. It gets its own columns beside Grok's so
-- the two never overwrite each other.
-- AlterTable
ALTER TABLE "OutreachScreenLabel" ADD COLUMN "claudeRisk" TEXT;
ALTER TABLE "OutreachScreenLabel" ADD COLUMN "claudeReason" TEXT;
