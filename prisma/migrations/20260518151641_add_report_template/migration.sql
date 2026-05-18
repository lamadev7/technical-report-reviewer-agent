-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "templateId" TEXT;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "KbTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
