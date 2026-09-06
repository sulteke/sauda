-- AlterTable
ALTER TABLE "boutiques" ADD COLUMN     "bio" TEXT,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "external_url" TEXT,
ADD COLUMN     "followers_count" INTEGER,
ADD COLUMN     "posts" JSONB;

