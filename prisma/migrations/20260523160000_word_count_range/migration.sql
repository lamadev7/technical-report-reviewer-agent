-- Rename wordCountLimit (acted as min threshold) to wordCountMin and add wordCountMax.
ALTER TABLE "Report" RENAME COLUMN "wordCountLimit" TO "wordCountMin";
ALTER TABLE "Report" ALTER COLUMN "wordCountMin" SET DEFAULT 0;
UPDATE "Report" SET "wordCountMin" = 0 WHERE "wordCountMin" = 10000;
ALTER TABLE "Report" ADD COLUMN "wordCountMax" INTEGER NOT NULL DEFAULT 0;
