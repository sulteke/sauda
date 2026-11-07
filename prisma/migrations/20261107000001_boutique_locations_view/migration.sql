-- Every venue (mall / building) each boutique was seen in, read live from
-- gis_stores. A boutique is stored once (instagram_handle is unique), so the
-- second venue that found it only marked its store KNOWN — but that store row
-- still carries the handle and the venue, and this view joins them back.
-- No data is copied: a new 2GIS run shows up here immediately.
--
-- One row per (boutique, venue): two storefronts of one account inside the same
-- venue collapse to the most recently refreshed one.
--
-- Additive only: creates a view, changes no table or row. Undo: DROP VIEW boutique_locations;
CREATE OR REPLACE VIEW "boutique_locations" AS
SELECT DISTINCT ON (b."id", g."location_id")
  b."id"                                    AS "boutique_id",
  b."instagram_handle"                      AS "instagram_handle",
  g."location_id"                           AS "location_id",
  COALESCE(g."location_name", g."location_id") AS "location_name",
  g."address"                               AS "address",
  g."latitude"                              AS "latitude",
  g."longitude"                             AS "longitude",
  g."gis_id"                                AS "gis_id",
  g."gis_url"                               AS "gis_url"
FROM "boutiques" b
JOIN "gis_stores" g ON g."instagram_handle" = b."instagram_handle"
ORDER BY b."id", g."location_id", g."updated_at" DESC;
