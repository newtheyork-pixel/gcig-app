-- CreateEnum
CREATE TYPE "VoteAction" AS ENUM ('Buy', 'Hold', 'Sell');

-- CreateTable
CREATE TABLE "Vote" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "action" "VoteAction" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" INTEGER NOT NULL,

    CONSTRAINT "Vote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Vote_createdAt_idx" ON "Vote"("createdAt");

-- AddForeignKey
ALTER TABLE "Vote" ADD CONSTRAINT "Vote_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
