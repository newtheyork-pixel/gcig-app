-- A signed TradeRequest can now be marked "filled", which writes the real
-- position + cash movements into the ledger (services/tradeExecution.js).
-- "executedAt" is both the settlement timestamp and the idempotency marker —
-- a request that already carries it can't be filled a second time. Both
-- columns are additive and nullable, so every existing request reads as
-- not-yet-filled and nothing is backfilled.
ALTER TABLE "TradeRequest" ADD COLUMN "executedAt" TIMESTAMP(3);
ALTER TABLE "TradeRequest" ADD COLUMN "executedByName" TEXT;
