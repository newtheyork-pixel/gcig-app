-- An outreach email and the two sign-offs it needs before it goes
-- out. The unique index on (draftId, userId) is the actual control:
-- without it "two approvals" is a counter one person can run up alone.
-- CreateTable
CREATE TABLE "OutreachDraft" (
    "id" SERIAL NOT NULL,
    "targetId" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorId" INTEGER,
    "rejectedById" INTEGER,
    "rejectedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "sentAt" TIMESTAMP(3),
    "sentById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachApproval" (
    "id" SERIAL NOT NULL,
    "draftId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutreachDraft_targetId_createdAt_idx" ON "OutreachDraft"("targetId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachApproval_draftId_userId_key" ON "OutreachApproval"("draftId", "userId");

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "ResearchTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_rejectedById_fkey" FOREIGN KEY ("rejectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_sentById_fkey" FOREIGN KEY ("sentById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachApproval" ADD CONSTRAINT "OutreachApproval_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "OutreachDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachApproval" ADD CONSTRAINT "OutreachApproval_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

