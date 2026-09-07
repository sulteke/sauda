-- AlterTable
ALTER TABLE "boutiques" ADD COLUMN     "business_address" JSONB,
ADD COLUMN     "external_urls" JSONB,
ADD COLUMN     "follows_count" INTEGER,
ADD COLUMN     "is_business_account" BOOLEAN,
ADD COLUMN     "is_private" BOOLEAN,
ADD COLUMN     "is_verified" BOOLEAN,
ADD COLUMN     "posts_count" INTEGER,
ADD COLUMN     "related_profiles" JSONB;
