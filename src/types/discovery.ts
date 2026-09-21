/** What a discovery run started from. GIS_LOCATION is location-first: a venue
 *  (2GIS building/place) whose businesses are enumerated before any Instagram. */
export type DiscoverySeedType = "PROFILE" | "HASHTAG" | "GIS_LOCATION";

export type DiscoveryCandidateStatus = "NEW" | "QUEUED" | "DISMISSED";

/** Serializable view of a discovered candidate account. */
export interface DiscoveryCandidateDTO {
  id: string;
  handle: string;
  instagramUrl: string;
  seedType: DiscoverySeedType;
  seedValue: string;
  source: string | null;
  /** Provenance beyond the seed (2GIS store + venue). Null for Instagram seeds. */
  sourceMeta: Record<string, unknown> | null;
  status: DiscoveryCandidateStatus;
  createdAt: string;
  updatedAt: string;
}
