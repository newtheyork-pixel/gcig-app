-- Two additions. minorEdit* records a post-approval change that
-- deliberately preserved its approvals. ownerOnly hides an artifact
-- from every read path except the super admin.
-- AlterTable
ALTER TABLE "ResearchArtifact" ADD COLUMN     "ownerOnly" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "OutreachDraft" ADD COLUMN     "minorEditAt" TIMESTAMP(3),
ADD COLUMN     "minorEditById" INTEGER,
ADD COLUMN     "minorEditNote" TEXT;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_minorEditById_fkey" FOREIGN KEY ("minorEditById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

