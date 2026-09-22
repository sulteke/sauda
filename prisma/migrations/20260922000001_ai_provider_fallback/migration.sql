-- Two-provider AI fallback.
-- Each Gemini provider uses its own Google Cloud project.

ALTER TABLE "import_jobs"
ADD COLUMN "analyzed_by" TEXT;

CREATE INDEX "import_jobs_analyzed_by_idx"
ON "import_jobs" ("analyzed_by");

CREATE TABLE "ai_provider_cooldowns" (
    "provider" TEXT NOT NULL,
    "cooldown_until" TIMESTAMP(3),
    "last_status" INTEGER,
    "last_error" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_provider_cooldowns_pkey"
        PRIMARY KEY ("provider")
);
