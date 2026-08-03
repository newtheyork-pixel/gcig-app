-- Paper orders: the forward test of the execution rules.
-- Deliberately unconnected to Holding, HoldingLot or Transaction.
CREATE TABLE "PaperOrder" (
  "id"           SERIAL PRIMARY KEY,
  "ticker"       TEXT NOT NULL,
  "side"         TEXT NOT NULL DEFAULT 'buy',
  "shares"       DOUBLE PRECISION NOT NULL,
  "arrivalPrice" DOUBLE PRECISION NOT NULL,
  "limitPrice"   DOUBLE PRECISION NOT NULL,
  "rationale"    TEXT,
  "status"       TEXT NOT NULL DEFAULT 'open',
  "placedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"    TIMESTAMP(3) NOT NULL,
  "filledAt"     TIMESTAMP(3),
  "fillPrice"    DOUBLE PRECISION,
  "polls"        INTEGER NOT NULL DEFAULT 0,
  "bestSeen"     DOUBLE PRECISION,
  "placedById"   INTEGER,
  "note"         TEXT
);
ALTER TABLE "PaperOrder" ADD CONSTRAINT "PaperOrder_placedById_fkey"
  FOREIGN KEY ("placedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "PaperOrder_status_idx" ON "PaperOrder"("status");
CREATE INDEX "PaperOrder_ticker_placedAt_idx" ON "PaperOrder"("ticker", "placedAt");
