-- Location-first discovery: a seed can now be a physical venue (2GIS building
-- or place), not only an Instagram profile or hashtag.
--
-- Split into its own migration because PostgreSQL forbids USING a newly added
-- enum value in the same transaction that adds it. Nothing here reads or writes
-- the value; the table that stores it lands in the next migration.
ALTER TYPE "DiscoverySeedType" ADD VALUE IF NOT EXISTS 'GIS_LOCATION';
