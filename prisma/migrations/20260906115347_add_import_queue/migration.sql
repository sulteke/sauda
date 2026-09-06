-- CreateEnum
CREATE TYPE "ImportQueueStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "import_queue" (
    "id" TEXT NOT NULL,
    "instagram_url" TEXT NOT NULL,
    "status" "ImportQueueStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_queue_status_idx" ON "import_queue"("status");

