-- CreateTable
CREATE TABLE "HoldingLot" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "shares" DOUBLE PRECISION NOT NULL,
    "pricePerShare" DOUBLE PRECISION NOT NULL,
    "buyDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HoldingLot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "HoldingLot_ticker_idx" ON "HoldingLot"("ticker");
