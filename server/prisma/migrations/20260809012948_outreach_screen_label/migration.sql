-- A human's verdict on a draft the screen already read, kept to
-- calibrate the screen. Its own table on purpose: labelled cases are the
-- eval set and must never become prompt examples, or we would be scoring
-- the screen against its own answer key. The frozen screenRiskAtLabel is
-- what the screen said about the exact words the grader saw.
-- CreateTable
CREATE TABLE "OutreachScreenLabel" (
    "id" SERIAL NOT NULL,
    "draftId" INTEGER NOT NULL,
    "humanRisk" TEXT NOT NULL,
    "humanCategory" TEXT,
    "humanNote" TEXT,
    "grokRisk" TEXT,
    "grokNote" TEXT,
    "screenRiskAtLabel" TEXT,
    "labeledById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachScreenLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutreachScreenLabel_draftId_key" ON "OutreachScreenLabel"("draftId");

-- AddForeignKey
ALTER TABLE "OutreachScreenLabel" ADD CONSTRAINT "OutreachScreenLabel_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "OutreachDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachScreenLabel" ADD CONSTRAINT "OutreachScreenLabel_labeledById_fkey" FOREIGN KEY ("labeledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
