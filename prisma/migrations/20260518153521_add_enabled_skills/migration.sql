-- AlterTable
ALTER TABLE "Report" ADD COLUMN     "enabledSkills" TEXT[] DEFAULT ARRAY[]::TEXT[];
