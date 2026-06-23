-- Holdings and cash are moving off the Google Sheet and into the database as
-- the new source of truth. This is the foundation migration: it widens the
-- (until now orphaned) Holding table into a real positions table and adds a
-- Transaction ledger so the cash balance can be DERIVED as SUM("cashDelta")
-- rather than stored. Nothing reads these yet — the live read path is still
-- the sheet — so this is safe to deploy ahead of the cutover. Every Holding
-- column is additive with a default, so any pre-existing rows are untouched.

-- Holding becomes the real positions table. "costBasis" stays as the blended
-- average cost it has always meant. "isCash" flags a cash row; "closedAt"
-- soft-closes a fully-sold position (the live query filters to NULL).
ALTER TABLE "Holding" ADD COLUMN "name" TEXT;
ALTER TABLE "Holding" ADD COLUMN "sector" TEXT;
ALTER TABLE "Holding" ADD COLUMN "isCash" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Holding" ADD COLUMN "closedAt" TIMESTAMP(3);
-- @updatedAt is app-managed and NOT NULL. Add it with a default so any
-- existing row gets a value, then drop the default to match Prisma's schema
-- (new rows are stamped by the client, not the database).
ALTER TABLE "Holding" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Holding" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- The Holding table was orphaned in the sheet era (zero reads, zero writes in
-- the codebase), so any rows are stale seed data that would otherwise (a) abort
-- this UNIQUE index if a ticker is duplicated — which records the migration
-- FAILED and makes prisma migrate deploy refuse every later migration on each
-- boot — and (b) surface as phantom positions the moment we cut over to the DB.
-- It carries no real data, so clear it before indexing.
DELETE FROM "Holding";

-- One position per ticker.
CREATE UNIQUE INDEX "Holding_ticker_key" ON "Holding"("ticker");

-- The cash + trade ledger. Cash = running sum of "cashDelta": buys /
-- withdrawals / fees negative, sells / deposits / dividends positive. Buys and
-- sells carry share + price detail; a sell carries realized P/L vs the blended
-- cost of the lots it relieved.
CREATE TABLE "Transaction" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "ticker" TEXT,
    "shares" DOUBLE PRECISION,
    "pricePerShare" DOUBLE PRECISION,
    "cashDelta" DOUBLE PRECISION NOT NULL,
    "realizedPnl" DOUBLE PRECISION,
    "tradeRequestId" INTEGER,
    "votingSessionId" INTEGER,
    "note" TEXT,
    "executedByName" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Transaction_ticker_idx" ON "Transaction"("ticker");

CREATE INDEX "Transaction_executedAt_idx" ON "Transaction"("executedAt");
