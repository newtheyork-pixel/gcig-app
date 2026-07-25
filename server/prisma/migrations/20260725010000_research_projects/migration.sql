-- Research projects: the container that holds an entire field-research
-- effort on one company in one place.
--
-- A channel-check effort accumulates far more than interviews — the
-- question guide written before the first call, store photos, a pricing
-- sheet a distributor emailed, the running memo. Scattering those makes
-- the work unreproducible six months later when someone asks where a
-- number came from. ResearchArtifact holds any of it, as either an
-- uploaded file or an inline text body.
--
-- Additive: two new tables plus one nullable column on Interview. The
-- column is nullable because a one-off call, or one logged before anyone
-- opened a project, is still a real interview and must stay valid.

CREATE TABLE "ResearchProject" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT,
    "name" TEXT NOT NULL,
    "brief" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ResearchArtifact" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'document',
    "title" TEXT NOT NULL,
    "fileRef" TEXT,
    "filename" TEXT,
    "body" TEXT,
    "note" TEXT,
    "uploadedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ResearchArtifact_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Interview" ADD COLUMN "projectId" INTEGER;

CREATE INDEX "ResearchProject_ticker_updatedAt_idx" ON "ResearchProject"("ticker", "updatedAt" DESC);
CREATE INDEX "ResearchProject_status_idx" ON "ResearchProject"("status");
CREATE INDEX "ResearchArtifact_projectId_kind_idx" ON "ResearchArtifact"("projectId", "kind");
CREATE INDEX "Interview_projectId_idx" ON "Interview"("projectId");

ALTER TABLE "ResearchProject" ADD CONSTRAINT "ResearchProject_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- Cascade: an artifact has no meaning without its project.
ALTER TABLE "ResearchArtifact" ADD CONSTRAINT "ResearchArtifact_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResearchArtifact" ADD CONSTRAINT "ResearchArtifact_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- SetNull, not Cascade: deleting a project must never delete the
-- interviews and claims gathered under it. Evidence outlives its folder.
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject"("id") ON DELETE SET NULL ON UPDATE CASCADE;
