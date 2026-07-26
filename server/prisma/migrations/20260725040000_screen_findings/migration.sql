-- Persist what the MNPI screen found, not just its verdict.
--
-- The screen produced a reason and the phrases that tripped it, then
-- threw both away and stored a single risk level. That left the
-- compliance view able to say "elevated" and nothing more, so it asked
-- the reader what they concluded — inverting the job. The model does the
-- catching; the person confirms or overrides it.
ALTER TABLE "Interview" ADD COLUMN "screenResult" JSONB;
