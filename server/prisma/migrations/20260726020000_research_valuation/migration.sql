-- CreateTable
CREATE TABLE "ResearchValuation" (
    "id" SERIAL NOT NULL,
    "projectId" INTEGER NOT NULL,
    "ticker" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'dcf',
    "name" TEXT NOT NULL,
    "bear" DOUBLE PRECISION,
    "base" DOUBLE PRECISION,
    "bull" DOUBLE PRECISION,
    "priceAtWrite" DOUBLE PRECISION,
    "assumptions" JSONB,
    "note" TEXT,
    "asOf" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchValuation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ResearchValuation_projectId_idx" ON "ResearchValuation"("projectId");

-- CreateIndex
CREATE INDEX "ResearchValuation_ticker_asOf_idx" ON "ResearchValuation"("ticker", "asOf" DESC);

-- AddForeignKey
ALTER TABLE "ResearchValuation" ADD CONSTRAINT "ResearchValuation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ResearchProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchValuation" ADD CONSTRAINT "ResearchValuation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

