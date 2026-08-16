-- Scheduling a send for later.
--
-- scheduledById is not optional in spirit: a scheduled email still has to
-- leave from a person's own mailbox, and a queue that forgot whose it was
-- would send from whoever the scheduler happened to run as.
ALTER TABLE "OutreachDraft" ADD COLUMN "scheduledFor" TIMESTAMP(3);
ALTER TABLE "OutreachDraft" ADD COLUMN "scheduledById" INTEGER;
ALTER TABLE "OutreachDraft" ADD COLUMN "scheduleError" TEXT;
ALTER TABLE "OutreachDraft" ADD CONSTRAINT "OutreachDraft_scheduledById_fkey"
  FOREIGN KEY ("scheduledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "OutreachDraft_scheduledFor_idx" ON "OutreachDraft"("scheduledFor");
