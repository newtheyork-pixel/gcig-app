-- Soft trash for research artifacts.
--
-- The Griffin Fund volume now honours a real Finder trash gesture, and a
-- gesture that destroys a project's evidence with no way back is not one
-- anybody should be able to make by accident with a mouse.
ALTER TABLE "ResearchArtifact" ADD COLUMN "trashedAt" TIMESTAMP(3);
ALTER TABLE "ResearchArtifact" ADD COLUMN "trashedById" INTEGER;

ALTER TABLE "ResearchArtifact"
  ADD CONSTRAINT "ResearchArtifact_trashedById_fkey"
  FOREIGN KEY ("trashedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ResearchArtifact_trashedAt_idx" ON "ResearchArtifact"("trashedAt");
