-- Richer Telegram failure diagnostics: store the full structured failure detail
-- (target, HTTP status, complete API response, timestamp) alongside the existing
-- untruncated telegram_error message. Additive; no behavior change.
ALTER TABLE "boutiques" ADD COLUMN "telegram_failure" JSONB;
