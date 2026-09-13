-- Decouple approval from Telegram publishing. Approval lives in `status`
-- (APPROVED means accepted into the platform, regardless of city). Telegram
-- publishing moves to its own `telegram_status` field, set only by the publisher.

CREATE TYPE "TelegramPublishStatus" AS ENUM ('PENDING', 'PUBLISHED', 'SKIPPED', 'FAILED');

ALTER TABLE "boutiques"
  ADD COLUMN "telegram_status" "TelegramPublishStatus" NOT NULL DEFAULT 'PENDING';

-- Migrate legacy Telegram-coupled statuses into the decoupled model. Read the
-- old status into telegram_status BEFORE collapsing those rows to APPROVED.
UPDATE "boutiques" SET "telegram_status" = 'PUBLISHED' WHERE "status" = 'PUBLISHED';
UPDATE "boutiques" SET "telegram_status" = 'FAILED' WHERE "status" = 'TELEGRAM_FAILED';

-- Every previously-approved boutique (queued, published, or failed under the old
-- coupled model) is simply APPROVED now; publishing state is carried separately.
UPDATE "boutiques"
  SET "status" = 'APPROVED'
  WHERE "status" IN ('READY_TO_PUBLISH', 'PUBLISHED', 'TELEGRAM_FAILED');

CREATE INDEX "boutiques_telegram_status_idx" ON "boutiques"("telegram_status");
