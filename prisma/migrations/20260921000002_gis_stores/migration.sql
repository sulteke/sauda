-- 2GIS location discovery: businesses enumerated from a venue.
--
-- Purely additive. `discovery_candidates` gains one nullable column and is
-- otherwise untouched, so Instagram hashtag/profile discovery, the import
-- queue and everything downstream keep working exactly as before.

CREATE TYPE "GisStoreStatus" AS ENUM ('NEW', 'INSTAGRAM_FOUND', 'NO_INSTAGRAM', 'KNOWN');

-- Provenance for a candidate beyond its seed (for 2GIS: the store + venue it
-- came from). Null for Instagram-sourced candidates, which the seed describes.
ALTER TABLE "discovery_candidates" ADD COLUMN "source_meta" JSONB;

-- One row per business enumerated from a 2GIS venue. Stores WITHOUT Instagram
-- are kept on purpose, so a later run knows they were already examined.
CREATE TABLE "gis_stores" (
    "id" TEXT NOT NULL,
    "gis_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "rubric" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "location_id" TEXT NOT NULL,
    "location_name" TEXT,
    "gis_url" TEXT,
    "source" TEXT NOT NULL,
    "status" "GisStoreStatus" NOT NULL DEFAULT 'NEW',
    "instagram_handle" TEXT,
    "instagram_url" TEXT,
    "candidate_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gis_stores_pkey" PRIMARY KEY ("id")
);

-- gis_id is the cross-run dedup key: a re-run enriches the existing row.
CREATE UNIQUE INDEX "gis_stores_gis_id_key" ON "gis_stores"("gis_id");
CREATE INDEX "gis_stores_location_id_idx" ON "gis_stores"("location_id");
CREATE INDEX "gis_stores_status_idx" ON "gis_stores"("status");
CREATE INDEX "gis_stores_instagram_handle_idx" ON "gis_stores"("instagram_handle");
