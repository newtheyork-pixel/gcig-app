CREATE TABLE "PersonProfile" (
    "id" SERIAL NOT NULL,
    "ticker" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "bio" TEXT,
    "bioSource" TEXT,
    "bioUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PersonProfile_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PersonProfile_ticker_name_kind_key" ON "PersonProfile"("ticker", "name", "kind");
CREATE INDEX "PersonProfile_ticker_idx" ON "PersonProfile"("ticker");

CREATE TABLE "CompanyProfile" (
    "ticker" TEXT NOT NULL,
    "description" TEXT,
    "descriptionSource" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CompanyProfile_pkey" PRIMARY KEY ("ticker")
);
