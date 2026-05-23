-- Set default word-count range to 10000-12000 and backfill existing rows
-- that are still at the legacy 0/0 defaults so they use the new range.
ALTER TABLE "Report" ALTER COLUMN "wordCountMin" SET DEFAULT 10000;
ALTER TABLE "Report" ALTER COLUMN "wordCountMax" SET DEFAULT 12000;
UPDATE "Report" SET "wordCountMin" = 10000 WHERE "wordCountMin" = 0;
UPDATE "Report" SET "wordCountMax" = 12000 WHERE "wordCountMax" = 0;
