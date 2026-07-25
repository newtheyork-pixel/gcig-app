-- The rest of the field-research process: the question spine, the
-- outreach funnel, and channel checks.
--
-- ResearchQuestion is the spine. Without it a project is a pile of
-- interesting facts with no finish line, and "done" quietly becomes
-- "tired of calling people". Claims and observations link back to a
-- question, which is what makes coverage computable.
--
-- ResearchTarget is the front of the funnel — leads, most of which never
-- become sources. Kept separate from ResearchSource so the source list
-- isn't polluted with people who never replied, and so the record of who
-- we could not reach survives, which is itself a finding.
--
-- SiteVisit / SiteObservation is going and looking rather than asking.
-- For a retail name it is most of the work. Observations are
-- deliberately NOT ResearchClaims: a claim is pinned to a millisecond in
-- a recording, and that guarantee is the point of the ledger. What
-- someone saw has no tape to walk back to, so it stays its own kind of
-- evidence rather than blurring the provenance of both.
--
-- Additive: four new tables plus one nullable column on ResearchClaim.

CREATE TABLE "ResearchQuestion" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "rationale" TEXT,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchQuestion_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "ResearchTarget" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "employer" TEXT,
    "role" TEXT,
    "channel" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Identified',
    "sourceId" INTEGER,
    "notes" TEXT,
    "lastContactAt" TIMESTAMP(3),
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchTarget_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SiteVisit" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "ticker" TEXT,
    "location" TEXT NOT NULL,
    "banner" TEXT,
    "visitedAt" TIMESTAMP(3) NOT NULL,
    "visitorId" INTEGER,
    "observations" JSONB,
    "notes" TEXT,
    "weather" TEXT,
    "dayPart" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteVisit_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SiteObservation" (
    "id" SERIAL NOT NULL,
    "visitId" INTEGER NOT NULL,
    "questionId" INTEGER,
    "text" TEXT NOT NULL,
    "topic" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'condition',
    "artifactId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteObservation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ResearchClaim" ADD COLUMN "questionId" INTEGER;

CREATE INDEX "ResearchClaim_questionId_idx" ON "ResearchClaim"("questionId");
CREATE INDEX "ResearchQuestion_projectId_rank_idx" ON "ResearchQuestion"("projectId", "rank");
CREATE INDEX "ResearchTarget_projectId_status_idx" ON "ResearchTarget"("projectId", "status");
CREATE INDEX "SiteVisit_projectId_visitedAt_idx" ON "SiteVisit"("projectId", "visitedAt" DESC);
CREATE INDEX "SiteObservation_visitId_idx" ON "SiteObservation"("visitId");
CREATE INDEX "SiteObservation_questionId_idx" ON "SiteObservation"("questionId");

ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ResearchQuestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResearchQuestion" ADD CONSTRAINT "ResearchQuestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchTarget" ADD CONSTRAINT "ResearchTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchTarget" ADD CONSTRAINT "ResearchTarget_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "ResearchSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ResearchTarget" ADD CONSTRAINT "ResearchTarget_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteVisit" ADD CONSTRAINT "SiteVisit_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SiteObservation" ADD CONSTRAINT "SiteObservation_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "SiteVisit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SiteObservation" ADD CONSTRAINT "SiteObservation_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "ResearchQuestion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
