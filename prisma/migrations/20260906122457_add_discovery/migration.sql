-- CreateEnum
CREATE TYPE "DiscoverySeedType" AS ENUM ('PROFILE', 'HASHTAG');

-- CreateEnum
CREATE TYPE "DiscoveryCandidateStatus" AS ENUM ('NEW', 'QUEUED', 'DISMISSED');

-- CreateTable
CREATE TABLE "discovery_candidates" (
    "id" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "instagram_url" TEXT NOT NULL,
    "seed_type" "DiscoverySeedType" NOT NULL,
    "seed_value" TEXT NOT NULL,
    "source" TEXT,
    "status" "DiscoveryCandidateStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovery_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discovery_candidates_status_idx" ON "discovery_candidates"("status");

-- CreateIndex
CREATE UNIQUE INDEX "discovery_candidates_handle_seed_value_key" ON "discovery_candidates"("handle", "seed_value");

