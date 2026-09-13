-- Two-stage import queue (Parse / Analyze): link column, new default, and a
-- non-destructive remap of in-flight rows. Terminal legacy rows (COMPLETED /
-- FAILED) are left untouched as historical records.

-- Link a queue row to the ImportJob created by the Parse stage.
ALTER TABLE "import_queue" ADD COLUMN "import_job_id" TEXT;

-- New rows start at the beginning of the Parse stage.
ALTER TABLE "import_queue" ALTER COLUMN "status" SET DEFAULT 'PENDING_PARSE';

-- Re-queue anything that was waiting or mid-run under the old single-stage
-- flow so it restarts cleanly from Parse (Apify has not necessarily run yet).
UPDATE "import_queue" SET "status" = 'PENDING_PARSE' WHERE "status" IN ('PENDING', 'PROCESSING');
