-- Daily-cadence storage of GSAM money market fund yields, scraped from
-- the public DailyRates PDF. One row per (ticker, date); re-scraping the
-- same day upserts. Used by the cash-interest service to accrue the
-- FGTXX sleeve of the club's cash position.
CREATE TABLE "MmfYieldSnapshot" (
  "id"                     SERIAL PRIMARY KEY,
  "ticker"                 TEXT NOT NULL,
  "date"                   TIMESTAMP(3) NOT NULL,
  "sevenDayCurrentYield"   DOUBLE PRECISION,
  "sevenDayEffectiveYield" DOUBLE PRECISION,
  "oneDayYield"            DOUBLE PRECISION,
  "dividendFactor"         DOUBLE PRECISION,
  "scrapedAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "MmfYieldSnapshot_ticker_date_key" ON "MmfYieldSnapshot" ("ticker", "date");
CREATE INDEX "MmfYieldSnapshot_ticker_date_idx" ON "MmfYieldSnapshot" ("ticker", "date");
