-- A sell vote can sell part of a position. Null = the whole position.
ALTER TABLE "VotingSession" ADD COLUMN "sellShares" INTEGER;
