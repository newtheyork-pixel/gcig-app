-- The labeling loop became paste-Grok-and-go: the reviewer no longer
-- hand-grades, they paste Grok's reply and we parse the verdict out of
-- it. So the human verdict is now optional, and we keep Grok's raw
-- response for the audit trail alongside the parsed risk/reason.
-- AlterTable
ALTER TABLE "OutreachScreenLabel" ALTER COLUMN "humanRisk" DROP NOT NULL;
ALTER TABLE "OutreachScreenLabel" ADD COLUMN "grokRaw" TEXT;
