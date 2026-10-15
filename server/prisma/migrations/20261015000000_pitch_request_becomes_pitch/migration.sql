-- An approved pitch request has to become a Pitch. Starting a vote
-- offers "Attach pitch", and that list is the Pitch table: a request
-- the President approved used to stay a PitchRequest and never appear,
-- while a pitch scheduled by hand for a member showed up immediately.
-- The pitches calendar and the assignment popup read the same table.
--
-- One request, one pitch. ON DELETE RESTRICT so removing the pitch
-- cannot silently drop the request off the vote list again.

ALTER TABLE "PitchRequest" ADD COLUMN "pitchId" INTEGER;

CREATE UNIQUE INDEX "PitchRequest_pitchId_key" ON "PitchRequest"("pitchId");

ALTER TABLE "PitchRequest"
ADD CONSTRAINT "PitchRequest_pitchId_fkey"
FOREIGN KEY ("pitchId") REFERENCES "Pitch"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
