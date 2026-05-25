-- Lower default wordCountMin from 10000 to 8000.
-- Backfills only rows still sitting on the previous default; user-edited
-- values are preserved.

ALTER TABLE "Report" ALTER COLUMN "wordCountMin" SET DEFAULT 8000;

UPDATE "Report" SET "wordCountMin" = 8000 WHERE "wordCountMin" = 10000;
