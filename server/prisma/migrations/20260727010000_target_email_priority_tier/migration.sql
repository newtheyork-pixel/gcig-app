-- An outreach list is a queue, not a set. Adds the address on its own
-- so the row can be clicked, a call order so the queue has a front, and
-- a short badge for the cut that matters on a given project — two
-- former employees can both be FormerEmployee and still answer
-- completely different questions.
-- AlterTable
ALTER TABLE "ResearchTarget" ADD COLUMN     "email" TEXT,
ADD COLUMN     "priority" INTEGER,
ADD COLUMN     "tier" TEXT;
