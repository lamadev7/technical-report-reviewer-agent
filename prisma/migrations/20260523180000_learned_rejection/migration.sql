CREATE TABLE "LearnedRejection" (
    "id" TEXT NOT NULL,
    "normalizedDesc" TEXT NOT NULL,
    "sampleDesc" TEXT NOT NULL,
    "sampleQuoted" TEXT NOT NULL,
    "category" "IssueCategory" NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LearnedRejection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LearnedRejection_normalizedDesc_key" ON "LearnedRejection"("normalizedDesc");
CREATE INDEX "LearnedRejection_hitCount_idx" ON "LearnedRejection"("hitCount");
