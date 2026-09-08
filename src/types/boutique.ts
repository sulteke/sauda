import type { ProductCategory } from "./category";
import type {
  InstagramBusinessAddress,
  InstagramExternalLink,
  InstagramPostChild,
  InstagramPostDimensions,
  InstagramPostMusic,
  InstagramRelatedProfile,
} from "./instagram";

export type BoutiqueStatus =
  | "DRAFT"
  | "NEEDS_REVIEW"
  | "READY_TO_PUBLISH"
  | "PUBLISHED"
  | "REJECTED"
  | "TELEGRAM_FAILED"
  | "ARCHIVED";

/**
 * A single Instagram post captured during import (snapshot, not re-scraped).
 * The first five fields are the original shape; the rest are richer metadata
 * added later and are optional so posts persisted before then still parse.
 */
export interface BoutiquePost {
  imageUrl: string | null;
  caption: string | null;
  likes: number | null;
  comments: number | null;
  permalink: string | null;
  type?: string | null;
  videoUrl?: string | null;
  hashtags?: string[];
  mentions?: string[];
  taggedUsers?: string[];
  locationName?: string | null;
  locationId?: string | null;
  childPosts?: InstagramPostChild[];
  musicInfo?: InstagramPostMusic | null;
  dimensions?: InstagramPostDimensions | null;
  isPinned?: boolean;
}

/** Serializable boutique shape returned to the client (dates as ISO strings). */
export interface BoutiqueDTO {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  city: string | null;
  status: BoutiqueStatus;
  telegramQueued: boolean;
  avatarUrl: string | null;
  bio: string | null;
  /** Primary detected product category label (backward-compatible single value). */
  category: string | null;
  /** All auto-detected product categories, richest-first. */
  productCategories: ProductCategory[];
  followersCount: number | null;
  externalUrl: string | null;
  instagramHandle: string | null;
  instagramUrl: string | null;
  telegramError: string | null;
  posts: BoutiquePost[];
  // Richer Instagram metadata captured at import time (nullable / defaulted so
  // rows imported before this milestone still serialize cleanly).
  isVerified: boolean | null;
  isBusinessAccount: boolean | null;
  isPrivate: boolean | null;
  postsCount: number | null;
  followsCount: number | null;
  businessAddress: InstagramBusinessAddress | null;
  externalUrls: InstagramExternalLink[];
  relatedProfiles: InstagramRelatedProfile[];
  lastImportedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
