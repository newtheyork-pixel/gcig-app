-- Backfill cashValue on each PortfolioSnapshot.
-- Cash stays flat for long stretches, changes when purchases/sales happen.
-- Using date-range UPDATE statements — much shorter than 180 individual rows.

UPDATE "PortfolioSnapshot" SET "cashValue" = 50824.02 WHERE date BETWEEN '2025-10-17' AND '2025-11-16';
UPDATE "PortfolioSnapshot" SET "cashValue" = 49015.72 WHERE date BETWEEN '2025-11-17' AND '2026-01-20';
UPDATE "PortfolioSnapshot" SET "cashValue" = 39275.47 WHERE date BETWEEN '2026-01-21' AND '2026-01-28';
UPDATE "PortfolioSnapshot" SET "cashValue" = 64275.47 WHERE date BETWEEN '2026-01-29' AND '2026-02-04';
UPDATE "PortfolioSnapshot" SET "cashValue" = 56474.85 WHERE date BETWEEN '2026-02-05' AND '2026-04-13';
UPDATE "PortfolioSnapshot" SET "cashValue" = 48782.29 WHERE date = '2026-04-14';
