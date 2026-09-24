-- A queue item whose Instagram handle already has a Boutique: skipped before
-- any scrape, so neither Apify nor Gemini is spent on a re-import.
-- Additive only: adds one enum value, changes no existing row or column.
ALTER TYPE "ImportQueueStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_DUPLICATE';
