-- A draft can now be QUEUED: written into somebody's mail client and
-- scheduled, but not yet gone. Sending is manual in this app, so "not
-- sent" used to cover both "nobody has touched this" and "this leaves on
-- Tuesday", which are different work for whoever is looking at the list.
ALTER TABLE "OutreachDraft" ADD COLUMN "queuedAt" TIMESTAMP(3);
ALTER TABLE "OutreachDraft" ADD COLUMN "queuedById" INTEGER;

-- SetNull, like every other actor column on this table: losing a user
-- must never delete the record of what was done.
ALTER TABLE "OutreachDraft"
  ADD CONSTRAINT "OutreachDraft_queuedById_fkey"
  FOREIGN KEY ("queuedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
