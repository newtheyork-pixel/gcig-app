-- CreateTable
CREATE TABLE "KnownLogin" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "ipHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnownLogin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnownLogin_userId_idx" ON "KnownLogin"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "KnownLogin_userId_ipHash_key" ON "KnownLogin"("userId", "ipHash");

-- AddForeignKey
ALTER TABLE "KnownLogin" ADD CONSTRAINT "KnownLogin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
