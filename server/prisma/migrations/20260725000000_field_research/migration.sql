-- Field research: the evidence chain behind primary reporting.
--
-- ResearchSource (who we talked to) -> Interview (the conversation, its
-- transcript and its consent record) -> ResearchClaim (one assertion,
-- pinned to a speaker and a millisecond offset in that transcript).
-- Reports cite claim ids, so any figure in a write-up walks back to the
-- moment it was said on tape.
--
-- Purely additive: three new tables and no change to any existing one,
-- so this deploys against live data with nothing to backfill.

CREATE TABLE "ResearchSource" (
    "id" SERIAL NOT NULL,
    "alias" TEXT NOT NULL,
    "fullName" TEXT,
    "role" TEXT,
    "employer" TEXT,
    "relationship" TEXT NOT NULL,
    "tickers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchSource_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Interview" (
    "id" SERIAL NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "ticker" TEXT,
    "title" TEXT NOT NULL,
    "conductedAt" TIMESTAMP(3) NOT NULL,
    "interviewerId" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "recordingRef" TEXT,
    "transcript" TEXT,
    "transcriptWords" JSONB,
    "transcriptModel" TEXT,
    "durationMs" INTEGER,
    "consentObtained" BOOLEAN NOT NULL DEFAULT false,
    "consentNote" TEXT,
    "mnpiRisk" TEXT NOT NULL DEFAULT 'low',
    "screenedAt" TIMESTAMP(3),
    "screenedById" INTEGER,
    "quarantined" BOOLEAN NOT NULL DEFAULT false,
    "quarantineNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Interview_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchClaim" (
    "id" SERIAL NOT NULL,
    "interviewId" INTEGER NOT NULL,
    "ticker" TEXT,
    "text" TEXT NOT NULL,
    "quote" TEXT,
    "speaker" TEXT,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER,
    "topic" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'fact',
    "extractionConfidence" DOUBLE PRECISION,
    "verifiedById" INTEGER,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearchClaim_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ResearchSource_relationship_idx" ON "ResearchSource"("relationship");
CREATE INDEX "Interview_ticker_conductedAt_idx" ON "Interview"("ticker", "conductedAt" DESC);
CREATE INDEX "Interview_sourceId_idx" ON "Interview"("sourceId");
CREATE INDEX "Interview_status_idx" ON "Interview"("status");
CREATE INDEX "ResearchClaim_ticker_topic_idx" ON "ResearchClaim"("ticker", "topic");
CREATE INDEX "ResearchClaim_interviewId_idx" ON "ResearchClaim"("interviewId");

ALTER TABLE "ResearchSource" ADD CONSTRAINT "ResearchSource_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Restrict, not Cascade: deleting a source must not silently delete the
-- interviews that cite it. Evidence outlives the contact record.
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ResearchSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_interviewerId_fkey" FOREIGN KEY ("interviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_screenedById_fkey" FOREIGN KEY ("screenedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "Interview"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
