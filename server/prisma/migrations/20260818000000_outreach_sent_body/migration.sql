-- The letter as it actually left. See the model comment: without it the
-- app rebuilds a sent email from the reader's own signature.
ALTER TABLE "OutreachDraft" ADD COLUMN "sentBody" TEXT;
