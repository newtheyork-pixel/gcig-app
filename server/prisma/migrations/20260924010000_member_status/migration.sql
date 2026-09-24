-- AlterTable
ALTER TABLE "User" ADD COLUMN     "memberStatus" TEXT NOT NULL DEFAULT 'Active',
ADD COLUMN     "memberStatusAt" TIMESTAMP(3),
ADD COLUMN     "memberStatusById" INTEGER,
ADD COLUMN     "memberStatusNote" TEXT;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_memberStatusById_fkey" FOREIGN KEY ("memberStatusById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

