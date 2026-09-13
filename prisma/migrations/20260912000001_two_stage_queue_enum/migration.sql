-- Two-stage import queue (Parse / Analyze): add the new lifecycle values.
-- Split into its own migration because PostgreSQL forbids using a newly added
-- enum value inside the same transaction that adds it (the remap + default
-- change live in the next migration).
ALTER TYPE "ImportQueueStatus" ADD VALUE IF NOT EXISTS 'PENDING_PARSE';
ALTER TYPE "ImportQueueStatus" ADD VALUE IF NOT EXISTS 'PARSING';
ALTER TYPE "ImportQueueStatus" ADD VALUE IF NOT EXISTS 'PENDING_ANALYSIS';
ALTER TYPE "ImportQueueStatus" ADD VALUE IF NOT EXISTS 'ANALYZING';
ALTER TYPE "ImportQueueStatus" ADD VALUE IF NOT EXISTS 'READY_FOR_REVIEW';
ALTER TYPE "ImportQueueStatus" ADD VALUE IF NOT EXISTS 'PARSE_FAILED';
ALTER TYPE "ImportQueueStatus" ADD VALUE IF NOT EXISTS 'ANALYSIS_FAILED';
