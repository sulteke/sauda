-- AlterTable
ALTER TABLE "boutiques" ADD COLUMN     "manual_categories_added" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "manual_categories_removed" TEXT[] DEFAULT ARRAY[]::TEXT[];
