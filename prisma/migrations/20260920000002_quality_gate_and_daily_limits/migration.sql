-- Quality gate + per-business-day limits + Telegram location override.
-- All additive (nullable columns, no defaults to backfill, no data rewritten),
-- so every existing row keeps its current state and every existing flow
-- (APPROVED / PENDING / PUBLISHED / SKIPPED / *_FAILED) is untouched.

-- When an AI call was actually issued for an import job. Stamped at invocation
-- time, so a failed call still counts against the daily provider quota.
ALTER TABLE "import_jobs" ADD COLUMN "analyzed_at" TIMESTAMP(3);
CREATE INDEX "import_jobs_analyzed_at_idx" ON "import_jobs" ("analyzed_at");

-- Admin confirmation that an Unknown-location boutique belongs to the channel's
-- city. Used ONLY for publication eligibility; the detected city is never changed.
ALTER TABLE "boutiques" ADD COLUMN "telegram_override_city" TEXT;

-- When the boutique was successfully posted. Sole source of truth for the
-- per-business-day publication limit: NULL for skipped / failed / pending rows.
-- Existing PUBLISHED rows stay NULL, so they do not consume today's allowance.
ALTER TABLE "boutiques" ADD COLUMN "telegram_published_at" TIMESTAMP(3);
CREATE INDEX "boutiques_telegram_published_at_idx" ON "boutiques" ("telegram_published_at");
