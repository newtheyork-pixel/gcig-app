-- Per-user named watchlists. Two relational tables mirroring the
-- project's per-user persistence pattern (cf. PresidentReview): a
-- Watchlist owned by a User, and WatchlistItem rows under it. The
-- cascade chains User -> Watchlist -> WatchlistItem so deleting an
-- account cleans up every list and every ticker on it. Names are
-- unique per user (not globally); a ticker is unique per list so a
-- re-add upserts to a no-op rather than duplicating.
CREATE TABLE "Watchlist" (
  "id"        SERIAL PRIMARY KEY,
  "userId"    INTEGER NOT NULL,
  "name"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Watchlist_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "Watchlist_userId_name_key"
  ON "Watchlist"("userId", "name");
CREATE INDEX "Watchlist_userId_idx"
  ON "Watchlist"("userId");

CREATE TABLE "WatchlistItem" (
  "id"          SERIAL PRIMARY KEY,
  "watchlistId" INTEGER NOT NULL,
  "ticker"      TEXT NOT NULL,
  "addedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WatchlistItem_watchlistId_fkey"
    FOREIGN KEY ("watchlistId") REFERENCES "Watchlist"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WatchlistItem_watchlistId_ticker_key"
  ON "WatchlistItem"("watchlistId", "ticker");
CREATE INDEX "WatchlistItem_watchlistId_idx"
  ON "WatchlistItem"("watchlistId");
