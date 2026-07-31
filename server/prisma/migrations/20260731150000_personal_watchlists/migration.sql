-- DropIndex
DROP INDEX "WatchlistItem_ticker_source_key";

-- AlterTable
ALTER TABLE "WatchlistItem" ADD COLUMN     "userId" INTEGER;

-- CreateIndex
CREATE INDEX "WatchlistItem_userId_idx" ON "WatchlistItem"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WatchlistItem_ticker_source_userId_key" ON "WatchlistItem"("ticker", "source", "userId");

-- AddForeignKey
ALTER TABLE "WatchlistItem" ADD CONSTRAINT "WatchlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

