-- AlterTable
ALTER TABLE "ResearchArtifact"
  ADD COLUMN "extractedText"      TEXT,
  ADD COLUMN "extractStatus"      TEXT NOT NULL DEFAULT 'never',
  ADD COLUMN "extractChars"       INTEGER,
  ADD COLUMN "extractError"       TEXT,
  ADD COLUMN "extractAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "extractAttempts"    INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "ResearchArtifact_extractStatus_idx" ON "ResearchArtifact"("extractStatus");
