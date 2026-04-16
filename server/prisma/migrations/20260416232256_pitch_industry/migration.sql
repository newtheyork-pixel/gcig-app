-- AlterTable
ALTER TABLE "Pitch" ADD COLUMN     "industryId" INTEGER;

-- AddForeignKey
ALTER TABLE "Pitch" ADD CONSTRAINT "Pitch_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
