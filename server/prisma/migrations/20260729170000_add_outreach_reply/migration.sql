-- CreateTable
CREATE TABLE "OutreachReply" (
    "id" SERIAL NOT NULL,
    "targetId" INTEGER NOT NULL,
    "draftId" INTEGER,
    "kind" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "body" TEXT,
    "action" TEXT,
    "recordedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutreachReply_targetId_receivedAt_idx" ON "OutreachReply"("targetId", "receivedAt");

-- AddForeignKey
ALTER TABLE "OutreachReply" ADD CONSTRAINT "OutreachReply_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "ResearchTarget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachReply" ADD CONSTRAINT "OutreachReply_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "OutreachDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachReply" ADD CONSTRAINT "OutreachReply_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

