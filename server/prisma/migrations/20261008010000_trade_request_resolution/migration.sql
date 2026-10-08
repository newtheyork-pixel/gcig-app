-- A trade approval's DocuSign status is not whether the broker
-- traded it. Superseded and cancelled close an envelope that never
-- executed, so "Mark filled" stops offering itself. settlementMode
-- separates a fill that wrote the book from a stamp that only records
-- the approval, for the case where holdings and cash already reflect
-- the trade and posting it again would double the position.
-- All additive and nullable: every existing row stays open and unfilled.
ALTER TABLE "TradeRequest" ADD COLUMN "resolution" TEXT;
ALTER TABLE "TradeRequest" ADD COLUMN "resolutionNote" TEXT;
ALTER TABLE "TradeRequest" ADD COLUMN "resolvedAt" TIMESTAMP(3);
ALTER TABLE "TradeRequest" ADD COLUMN "resolvedByName" TEXT;
ALTER TABLE "TradeRequest" ADD COLUMN "settlementMode" TEXT;
ALTER TABLE "TradeRequest" ADD COLUMN "fillRecord" JSONB;
