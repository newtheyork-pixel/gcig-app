-- The compliance read on an outreach email. Re-run on every edit,
-- because it is the words that were screened. A null screenedAt means
-- nobody has read it yet and must not render as clean.
-- AlterTable
ALTER TABLE "OutreachDraft" ADD COLUMN     "screenFindings" JSONB,
ADD COLUMN     "screenModelOk" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "screenReason" TEXT,
ADD COLUMN     "screenRisk" TEXT,
ADD COLUMN     "screenedAt" TIMESTAMP(3);

