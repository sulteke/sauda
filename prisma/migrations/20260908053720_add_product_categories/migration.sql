-- AlterTable
ALTER TABLE "boutiques" ADD COLUMN     "product_categories" TEXT[] DEFAULT ARRAY[]::TEXT[];
