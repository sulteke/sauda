-- Quality gate: a terminal, non-failure outcome for accounts that never reach
-- the AI stage because they are below the follower threshold (or have no
-- follower count at all).
--
-- Split into its own migration because PostgreSQL forbids USING a newly added
-- enum value inside the same transaction that adds it. Nothing here reads or
-- writes the value; the columns and any use of it land in the next migration.
ALTER TYPE "ImportQueueStatus" ADD VALUE IF NOT EXISTS 'SKIPPED_LOW_FOLLOWERS';
