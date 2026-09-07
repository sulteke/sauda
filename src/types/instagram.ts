/**
 * Shared, source-agnostic shapes for the richer Instagram metadata captured at
 * import time. Defined once here so the provider layer, DTOs, persistence and UI
 * all speak the same vocabulary. Plain types only — safe on server and client.
 */

/** A physical business address attached to an Instagram business profile. */
export interface InstagramBusinessAddress {
  cityName: string | null;
  streetAddress: string | null;
  zipCode: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** One labeled external link from a profile's link list. */
export interface InstagramExternalLink {
  title: string | null;
  url: string;
}

/** A related / suggested profile surfaced alongside a profile. */
export interface InstagramRelatedProfile {
  username: string;
  fullName: string | null;
  isVerified: boolean;
  profilePicUrl: string | null;
}

/** A child item of a carousel ("Sidecar") post. */
export interface InstagramPostChild {
  type: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
}

/** Audio track attached to a Reel / video post. */
export interface InstagramPostMusic {
  artistName: string | null;
  songName: string | null;
}

/** Pixel dimensions of a post's primary media. */
export interface InstagramPostDimensions {
  width: number | null;
  height: number | null;
}
