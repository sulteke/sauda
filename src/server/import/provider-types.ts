import type {
  InstagramBusinessAddress,
  InstagramExternalLink,
  InstagramPostChild,
  InstagramPostDimensions,
  InstagramPostMusic,
  InstagramRelatedProfile,
} from "@/types/instagram";

/**
 * Maximum recent posts imported per profile. The Instagram Profile Scraper
 * returns at most ~12 `latestPosts` regardless of the `resultsLimit` sent
 * (verified empirically against real business accounts at limits 30/50/100 —
 * all returned 12), so 12 is the stable ceiling for the current actor. Fetching
 * 30–50 would require a different actor or post pagination, which would change
 * the architecture. Every provider caps its `recentPosts` at this value.
 */
export const MAX_RECENT_POSTS = 12;

/**
 * Source-agnostic shape of a discovered Instagram profile. Every provider —
 * mock today, a real scraper tomorrow — returns this exact shape, so the import
 * pipeline never changes when the source changes.
 */
export interface RawInstagramPost {
  imageUrl: string | null;
  caption: string | null;
  likes: number | null;
  comments: number | null;
  permalink: string | null;
  /** Media/post type, e.g. "Image", "Video", "Sidecar". */
  type: string | null;
  videoUrl: string | null;
  hashtags: string[];
  mentions: string[];
  /** Usernames tagged in the post. */
  taggedUsers: string[];
  locationName: string | null;
  locationId: string | null;
  /** Carousel children (empty for single-media posts). */
  childPosts: InstagramPostChild[];
  musicInfo: InstagramPostMusic | null;
  dimensions: InstagramPostDimensions | null;
  isPinned: boolean;
}

export interface RawInstagramProfile {
  handle: string;
  fullName: string | null;
  biography: string | null;
  profilePicUrl: string | null;
  externalUrl: string | null;
  followersCount: number | null;
  isVerified: boolean;
  /** First recent posts captured at import time (already normalized). */
  recentPosts: RawInstagramPost[];
  // Richer profile metadata surfaced by the scraper.
  postsCount: number | null;
  followsCount: number | null;
  isBusinessAccount: boolean;
  isPrivate: boolean;
  businessAddress: InstagramBusinessAddress | null;
  externalUrls: InstagramExternalLink[];
  relatedProfiles: InstagramRelatedProfile[];
  sourceUrl: string;
  fetchedAt: string;
  /** Untouched provider payload, stored for re-mapping without re-scraping. */
  raw: Record<string, unknown>;
}

export interface InstagramProfileRequest {
  url: string;
  handle: string;
}

/** The single seam between the pipeline and any Instagram data source. */
export interface InstagramProvider {
  readonly name: string;
  fetchProfile(request: InstagramProfileRequest): Promise<RawInstagramProfile>;
}
