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
}

export interface RawInstagramProfile {
  handle: string;
  fullName: string | null;
  biography: string | null;
  profilePicUrl: string | null;
  externalUrl: string | null;
  followersCount: number | null;
  isVerified: boolean;
  category: string | null;
  /** First recent posts captured at import time (already normalized). */
  recentPosts: RawInstagramPost[];
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
