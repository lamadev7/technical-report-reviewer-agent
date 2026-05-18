-- CreateEnum
CREATE TYPE "ReviewMode" AS ENUM ('STRICT', 'MODERATE', 'ACCEPTABLE');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('CRITICAL', 'MAJOR');

-- CreateEnum
CREATE TYPE "IssueCategory" AS ENUM ('GRAMMAR', 'FORMAT', 'COMPLETENESS', 'SECTION_QUALITY', 'OTHER');

-- CreateEnum
CREATE TYPE "IssueSource" AS ENUM ('AGENT', 'REVIEWER');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('UPLOADED', 'REVIEWING', 'REVIEWED', 'APPROVED', 'SENT');

-- CreateEnum
CREATE TYPE "SampleQuality" AS ENUM ('EXCELLENT', 'BAD');

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalPath" TEXT NOT NULL,
    "htmlContent" TEXT NOT NULL,
    "plainText" TEXT NOT NULL,
    "offsetMap" JSONB NOT NULL,
    "studentName" TEXT,
    "studentEmail" TEXT,
    "reviewMode" "ReviewMode" NOT NULL DEFAULT 'MODERATE',
    "markingMode" "ReviewMode" NOT NULL DEFAULT 'MODERATE',
    "marking" JSONB,
    "status" "ReportStatus" NOT NULL DEFAULT 'UPLOADED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "startOffset" INTEGER NOT NULL,
    "endOffset" INTEGER NOT NULL,
    "anchorPath" TEXT,
    "quotedText" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "category" "IssueCategory" NOT NULL,
    "shortDescription" TEXT NOT NULL,
    "source" "IssueSource" NOT NULL DEFAULT 'AGENT',
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "htmlContent" TEXT NOT NULL,
    "plainText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KbSample" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "quality" "SampleQuality" NOT NULL,
    "filePath" TEXT NOT NULL,
    "htmlContent" TEXT NOT NULL,
    "plainText" TEXT NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KbSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Report_studentName_idx" ON "Report"("studentName");

-- CreateIndex
CREATE INDEX "Report_status_idx" ON "Report"("status");

-- CreateIndex
CREATE INDEX "Report_createdAt_idx" ON "Report"("createdAt");

-- CreateIndex
CREATE INDEX "Issue_reportId_idx" ON "Issue"("reportId");

-- CreateIndex
CREATE INDEX "KbSample_quality_idx" ON "KbSample"("quality");

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report"("id") ON DELETE CASCADE ON UPDATE CASCADE;
