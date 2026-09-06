export type DiscoverySeedType = "PROFILE" | "HASHTAG";

export type DiscoveryCandidateStatus = "NEW" | "QUEUED" | "DISMISSED";

/** Serializable view of a discovered candidate account. */
export interface DiscoveryCandidateDTO {
  id: string;
  handle: string;
  instagramUrl: string;
  seedType: DiscoverySeedType;
  seedValue: string;
  source: string | null;
  status: DiscoveryCandidateStatus;
  createdAt: string;
  updatedAt: string;
}
