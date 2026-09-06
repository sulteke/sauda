-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "BoutiqueStatus" AS ENUM ('DRAFT', 'NEEDS_REVIEW', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ImportSource" AS ENUM ('INSTAGRAM');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY_FOR_REVIEW', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "boutiques" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "city" TEXT,
    "status" "BoutiqueStatus" NOT NULL DEFAULT 'DRAFT',
    "instagram_handle" TEXT,
    "instagram_url" TEXT,
    "avatar_url" TEXT,
    "telegram_queued" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "boutiques_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" TEXT NOT NULL,
    "source" "ImportSource" NOT NULL DEFAULT 'INSTAGRAM',
    "source_url" TEXT NOT NULL,
    "handle" TEXT,
    "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
    "raw_profile" JSONB,
    "preview" JSONB,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "boutique_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "boutiques_slug_key" ON "boutiques"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "boutiques_instagram_handle_key" ON "boutiques"("instagram_handle");

-- CreateIndex
CREATE INDEX "boutiques_status_idx" ON "boutiques"("status");

-- CreateIndex
CREATE INDEX "boutiques_telegram_queued_idx" ON "boutiques"("telegram_queued");

-- CreateIndex
CREATE INDEX "import_jobs_status_idx" ON "import_jobs"("status");

-- CreateIndex
CREATE INDEX "import_jobs_handle_idx" ON "import_jobs"("handle");

-- CreateIndex
CREATE INDEX "import_jobs_boutique_id_idx" ON "import_jobs"("boutique_id");

-- AddForeignKey
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_boutique_id_fkey" FOREIGN KEY ("boutique_id") REFERENCES "boutiques"("id") ON DELETE SET NULL ON UPDATE CASCADE;

