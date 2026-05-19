-- Per-user price / day-%-move alert rules. One table, owned by a User,
-- independent of any Watchlist (a rule is just user + ticker +
-- condition) so it survives a ticker leaving a list. `metric` is
-- 'price' or 'pct', `direction` is 'above' or 'below', `threshold` is
-- a double. `active` defaults true; a rule is one-shot — when the
-- client poller sees it cross it stamps `lastFiredAt` and flips
-- `active` false so the same crossing can't re-spam the popup. Cascade
-- from User so deleting an account drops every rule. Same conventions
-- as the watchlists / president_review migrations: SERIAL pk, INTEGER
-- FK with ON DELETE/UPDATE CASCADE, a userId index for the per-user
-- scan every endpoint does.
CREATE TABLE "WatchlistAlert" (
  "id"          SERIAL PRIMARY KEY,
  "userId"      INTEGER NOT NULL,
  "ticker"      TEXT NOT NULL,
  "metric"      TEXT NOT NULL,
  "direction"   TEXT NOT NULL,
  "threshold"   DOUBLE PRECISION NOT NULL,
  "active"      BOOLEAN NOT NULL DEFAULT true,
  "lastFiredAt" TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WatchlistAlert_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "WatchlistAlert_userId_idx"
  ON "WatchlistAlert"("userId");
