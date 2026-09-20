-- Backfill telegram_published_at for boutiques published BEFORE this column
-- existed, so the new per-business-day limit does not start today at zero.
--
-- There is no historical publication timestamp in the schema, and none can be
-- recovered externally: the Telegram Bot API does not let a bot read a channel's
-- message history. The available columns are created_at (import time, unrelated
-- to publishing), telegram_failure->>'failedAt' (failures only), and updated_at.
--
-- updated_at is the correct proxy, because it can only ERR TOWARD CAUTION:
-- publishing itself writes telegram_status/telegram_error/telegram_failure, so
-- updated_at >= the real publication time for every published row, always. A
-- later unrelated edit pushes it further forward, never backward. So treating
-- updated_at as the publication time can only move a row INTO today's window,
-- never out of it — it may slightly over-count today's publications, and can
-- never under-count them. Over-counting merely publishes a little less today;
-- under-counting would silently exceed the daily limit, which is the outcome
-- this backfill exists to prevent.
--
-- Observed at the time of writing: of 17 published boutiques, 7 were last
-- updated inside the current Asia/Almaty business day, clustered in two tight
-- batches (three within 23s, four within 25s) that match individual publish
-- runs. Without this backfill the system would have allowed 20 MORE posts today
-- on top of those 7.
--
-- Scoped to PUBLISHED rows only: skipped, failed and pending boutiques were
-- never posted and must keep a NULL stamp so they never consume the allowance.
UPDATE "boutiques"
SET "telegram_published_at" = "updated_at"
WHERE "telegram_status" = 'PUBLISHED'
  AND "telegram_published_at" IS NULL;
