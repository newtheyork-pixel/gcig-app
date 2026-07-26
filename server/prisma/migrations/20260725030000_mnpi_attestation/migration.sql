-- MNPI: the parts that govern behaviour rather than describe it.
--
-- The automated screen reads a transcript after the fact. Two things it
-- cannot do: shape the conversation before it happens, and decide what a
-- flag means. Attestation is the interviewer stating, before the call,
-- that they will not seek material non-public information. Review is a
-- person's judgement on a flagged transcript — distinct from the machine
-- flag, because a flag nobody has read is an open question, not a
-- decision.
--
-- Additive: five nullable columns on Interview.
ALTER TABLE "Interview" ADD COLUMN "attestedAt" TIMESTAMP(3);
ALTER TABLE "Interview" ADD COLUMN "attestedById" INTEGER;
ALTER TABLE "Interview" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "Interview" ADD COLUMN "reviewedById" INTEGER;
ALTER TABLE "Interview" ADD COLUMN "reviewNote" TEXT;

ALTER TABLE "Interview" ADD CONSTRAINT "Interview_attestedById_fkey" FOREIGN KEY ("attestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Interview" ADD CONSTRAINT "Interview_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Interview_mnpiRisk_idx" ON "Interview"("mnpiRisk");
