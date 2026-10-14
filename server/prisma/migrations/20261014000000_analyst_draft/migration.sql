-- Analyst draft. Portfolio managers take turns claiming analysts.
-- Coverage (UserIndustry) is left alone: a drafted analyst keeps the
-- industry they cover, and the pod they join is PmPodMember.
-- Class year is optional because the roster never collected one.

ALTER TABLE "User" ADD COLUMN "classYear" INTEGER;

CREATE TABLE "AnalystDraft" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'setup',
    "rounds" INTEGER NOT NULL,
    "pickSeconds" INTEGER NOT NULL DEFAULT 30,
    "snake" BOOLEAN NOT NULL DEFAULT true,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "clockEndsAt" TIMESTAMP(3),
    "pausedRemainingMs" INTEGER,
    "pickIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AnalystDraft_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DraftSeat" (
    "id" SERIAL NOT NULL,
    "draftId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "slot" INTEGER NOT NULL,

    CONSTRAINT "DraftSeat_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DraftEligible" (
    "id" SERIAL NOT NULL,
    "draftId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,

    CONSTRAINT "DraftEligible_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DraftPick" (
    "id" SERIAL NOT NULL,
    "draftId" INTEGER NOT NULL,
    "pickNumber" INTEGER NOT NULL,
    "round" INTEGER NOT NULL,
    "slotInRound" INTEGER NOT NULL,
    "pmId" INTEGER NOT NULL,
    "analystId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "pickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DraftPick_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DraftQueueRank" (
    "id" SERIAL NOT NULL,
    "draftId" INTEGER NOT NULL,
    "pmId" INTEGER NOT NULL,
    "analystId" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,

    CONSTRAINT "DraftQueueRank_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PmPodMember" (
    "id" SERIAL NOT NULL,
    "pmId" INTEGER NOT NULL,
    "analystId" INTEGER NOT NULL,
    "draftId" INTEGER NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PmPodMember_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AnalystDraft_status_idx" ON "AnalystDraft"("status");
CREATE INDEX "AnalystDraft_createdById_idx" ON "AnalystDraft"("createdById");

CREATE UNIQUE INDEX "DraftSeat_draftId_userId_key" ON "DraftSeat"("draftId", "userId");
CREATE UNIQUE INDEX "DraftSeat_draftId_slot_key" ON "DraftSeat"("draftId", "slot");
CREATE INDEX "DraftSeat_userId_idx" ON "DraftSeat"("userId");

CREATE UNIQUE INDEX "DraftEligible_draftId_userId_key" ON "DraftEligible"("draftId", "userId");
CREATE INDEX "DraftEligible_userId_idx" ON "DraftEligible"("userId");

CREATE UNIQUE INDEX "DraftPick_draftId_pickNumber_key" ON "DraftPick"("draftId", "pickNumber");
CREATE UNIQUE INDEX "DraftPick_draftId_analystId_key" ON "DraftPick"("draftId", "analystId");
CREATE INDEX "DraftPick_pmId_idx" ON "DraftPick"("pmId");
CREATE INDEX "DraftPick_analystId_idx" ON "DraftPick"("analystId");

CREATE UNIQUE INDEX "DraftQueueRank_draftId_pmId_rank_key" ON "DraftQueueRank"("draftId", "pmId", "rank");
CREATE UNIQUE INDEX "DraftQueueRank_draftId_pmId_analystId_key" ON "DraftQueueRank"("draftId", "pmId", "analystId");
CREATE INDEX "DraftQueueRank_pmId_idx" ON "DraftQueueRank"("pmId");

CREATE UNIQUE INDEX "PmPodMember_analystId_key" ON "PmPodMember"("analystId");
CREATE INDEX "PmPodMember_pmId_idx" ON "PmPodMember"("pmId");
CREATE INDEX "PmPodMember_draftId_idx" ON "PmPodMember"("draftId");

ALTER TABLE "AnalystDraft" ADD CONSTRAINT "AnalystDraft_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DraftSeat" ADD CONSTRAINT "DraftSeat_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "AnalystDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DraftSeat" ADD CONSTRAINT "DraftSeat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DraftEligible" ADD CONSTRAINT "DraftEligible_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "AnalystDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DraftEligible" ADD CONSTRAINT "DraftEligible_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DraftPick" ADD CONSTRAINT "DraftPick_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "AnalystDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DraftPick" ADD CONSTRAINT "DraftPick_pmId_fkey" FOREIGN KEY ("pmId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "DraftPick" ADD CONSTRAINT "DraftPick_analystId_fkey" FOREIGN KEY ("analystId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "DraftQueueRank" ADD CONSTRAINT "DraftQueueRank_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "AnalystDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DraftQueueRank" ADD CONSTRAINT "DraftQueueRank_pmId_fkey" FOREIGN KEY ("pmId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DraftQueueRank" ADD CONSTRAINT "DraftQueueRank_analystId_fkey" FOREIGN KEY ("analystId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PmPodMember" ADD CONSTRAINT "PmPodMember_pmId_fkey" FOREIGN KEY ("pmId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PmPodMember" ADD CONSTRAINT "PmPodMember_analystId_fkey" FOREIGN KEY ("analystId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PmPodMember" ADD CONSTRAINT "PmPodMember_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "AnalystDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;
